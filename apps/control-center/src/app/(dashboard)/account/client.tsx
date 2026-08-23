"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";
import {
    LinkIcon,
    Unlink,
    RefreshCw,
    ShieldCheck,
    Bot,
    Download,
    Eye,
    EyeOff,
    CheckCircle2,
    AlertCircle,
    Cable,
    ExternalLink,
} from "lucide-react";
import { REGIONS } from "@/lib/regions";
import { cn } from "@/lib/utils";
import {
    linkVintedAccount,
    unlinkVintedAccount,
    getAccountStatus,
    refreshVintedSession,
    updateVintedPhoneNumber,
    updateVintedDomain,
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
    last_refresh_at?: string;
    last_valid_at?: string;
    invalid_reason?: string;
    has_refresh_token?: boolean;
    requires_browser_reauth?: boolean;
    requires_browser_sync?: boolean;
    browser_link_connected?: boolean;
    has_browser_session?: boolean;
    browser_linked?: boolean;
    last_browser_sync?: string;
    has_phone_number?: boolean;
    dedupe_monitor_alerts?: boolean;
}

type BrowserSyncState = {
    token: string;
    installed?: boolean;
    configured?: boolean;
    created_at: string;
    expires_at?: string | null;
    persistent?: boolean;
    last_used_at?: string;
    syncedDomains?: string[];
    error?: string;
};

type ExtensionSyncResult = {
    ok?: boolean;
    status?: string;
    domain?: string;
    vintedId?: number;
    vintedName?: string;
    error?: string;
    reason?: string;
};

const CHROME_EXTENSION_DOWNLOAD_URL =
    "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension.zip";

function sessionStatusLabel(value?: string) {
    switch (value) {
        case "active":
            return "Active";
        case "degraded":
            return "Retrying";
        case "needs_browser_reauth":
            return "Session update needed";
        case "needs_browser_sync":
            return "Browser sync needed";
        case "missing_refresh_token":
            return "Refresh token missing";
        case "refreshing":
            return "Refreshing";
        default:
            return value || "Unknown";
    }
}

function formatSessionTimestamp(value?: string) {
    if (!value) return "not yet";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "not yet";
    return date.toLocaleString();
}

function getCompletedSyncs(results?: ExtensionSyncResult[]) {
    return (results || []).filter(
        (result) =>
            result.ok &&
            (!result.status ||
                result.status === "completed" ||
                result.status === "refreshed"),
    );
}

function getSyncIssue(results?: ExtensionSyncResult[]) {
    return (results || []).find(
        (result) =>
            !result.ok ||
            result.status === "ignored_invalid_browser_session" ||
            result.status === "ignored_account",
    );
}

function compareExtensionVersions(current: string, target: string) {
    const currentParts = current.split(".").map((part) => Number(part) || 0);
    const targetParts = target.split(".").map((part) => Number(part) || 0);
    const length = Math.max(currentParts.length, targetParts.length);

    for (let index = 0; index < length; index += 1) {
        const currentPart = currentParts[index] || 0;
        const targetPart = targetParts[index] || 0;
        if (currentPart !== targetPart) {
            return currentPart > targetPart ? 1 : -1;
        }
    }

    return 0;
}

function extensionNotDetectedMessage() {
    if (
        typeof window !== "undefined" &&
        (window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1")
    ) {
        return "The public extension cannot access localhost. Load the unpacked chrome-development build and reload this page.";
    }
    return "Browser extension not detected. Install it, then reload this page.";
}

export function AccountClient({
    initialStatus,
    latestExtensionVersion,
    minimumExtensionVersion,
    firefoxExtensionUrl,
}: {
    initialStatus: AccountStatus;
    latestExtensionVersion: string;
    minimumExtensionVersion: string;
    firefoxExtensionUrl: string;
}) {
    const [status, setStatus] = useState<AccountStatus>(initialStatus);
    const [accessToken, setAccessToken] = useState("");
    const [refreshToken, setRefreshToken] = useState("");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [linkedPhoneNumber, setLinkedPhoneNumber] = useState("");
    const [browserSync, setBrowserSync] = useState<BrowserSyncState | null>(
        null,
    );
    const [extensionInstalled, setExtensionInstalled] = useState(false);
    const [extensionConfigured, setExtensionConfigured] = useState(false);
    const [extensionVersion, setExtensionVersion] = useState<string | null>(
        null,
    );
    const [selectedRegion, setSelectedRegion] = useState(() => {
        const matchingRegion = REGIONS.find(
            (region) =>
                initialStatus.domain === region.domain ||
                initialStatus.domain === `www.${region.domain}`,
        );
        return matchingRegion?.code || "de";
    });
    const [isVintedIdVisible, setIsVintedIdVisible] = useState(false);
    const [isUnlinkDialogOpen, setIsUnlinkDialogOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const [isBrowserSyncStarting, setIsBrowserSyncStarting] = useState(false);

    const selectedDomain =
        REGIONS.find((r) => r.code === selectedRegion)?.domain || "vinted.de";
    const targetDomain = `www.${selectedDomain}`;

    useEffect(() => {
        if (!status.domain) {
            return;
        }

        const matchingRegion = REGIONS.find(
            (region) =>
                status.domain === region.domain ||
                status.domain === `www.${region.domain}`,
        );
        if (matchingRegion) {
            setSelectedRegion(matchingRegion.code);
        }
    }, [status.domain]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const handleMessage = (event: MessageEvent) => {
            if (event.source !== window || !event.data?.type) {
                return;
            }

            if (event.data.type === "VINTRACK_EXTENSION_READY") {
                setExtensionInstalled(
                    Boolean(event.data.payload?.installed ?? true),
                );
                setExtensionConfigured(Boolean(event.data.payload?.configured));
                setExtensionVersion(
                    typeof event.data.payload?.version === "string" &&
                        event.data.payload.version.trim()
                        ? event.data.payload.version.trim()
                        : null,
                );
                return;
            }

            if (event.data.type === "VINTRACK_EXTENSION_CONNECT_RESULT") {
                setIsBrowserSyncStarting(false);

                const payload = event.data.payload as {
                    ok?: boolean;
                    syncOk?: boolean;
                    error?: string;
                    syncedDomains?: string[];
                    configured?: boolean;
                    version?: string;
                    results?: ExtensionSyncResult[];
                };

                if (!payload?.ok) {
                    toast.error(
                        payload?.error || "Failed to connect browser extension",
                    );
                    return;
                }

                setExtensionInstalled(true);
                setExtensionConfigured(Boolean(payload.configured ?? true));
                setExtensionVersion(
                    typeof payload.version === "string" &&
                        payload.version.trim()
                        ? payload.version.trim()
                        : null,
                );
                setBrowserSync((current) =>
                    current
                        ? {
                              ...current,
                              configured: true,
                              syncedDomains:
                                  payload.syncedDomains ||
                                  getCompletedSyncs(payload.results)
                                      .map((result) => result.domain || "")
                                      .filter(Boolean),
                          }
                        : current,
                );

                const completedSyncs = getCompletedSyncs(payload.results);
                const syncedCount =
                    completedSyncs.length || payload.syncedDomains?.length || 0;
                if (payload.syncOk !== false && syncedCount > 0) {
                    const syncedAccount = completedSyncs.find(
                        (result) => result.vintedName,
                    )?.vintedName;
                    toast.success(
                        syncedAccount
                            ? `Extension connected to @${syncedAccount}`
                            : `Extension connected and synced ${syncedCount} Vinted session${syncedCount === 1 ? "" : "s"}`,
                    );
                } else {
                    const issue = getSyncIssue(payload.results);
                    toast.warning(
                        payload.error ||
                            issue?.error ||
                            issue?.reason ||
                            "Extension connected, but no fresh Vinted browser session was found.",
                    );
                }

                void getAccountStatus().then((updated) => {
                    setStatus(updated);
                });
                return;
            }

            if (event.data.type === "VINTRACK_EXTENSION_MANUAL_SYNC_RESULT") {
                const payload = event.data.payload as {
                    ok?: boolean;
                    error?: string;
                    results?: ExtensionSyncResult[];
                };

                if (!payload?.ok) {
                    toast.error(payload?.error || "Extension sync failed");
                    return;
                }

                const completedSyncs = getCompletedSyncs(payload.results);
                if (completedSyncs.length > 0) {
                    const syncedAccount = completedSyncs.find(
                        (result) => result.vintedName,
                    )?.vintedName;
                    toast.success(
                        syncedAccount
                            ? `Synced Vinted account @${syncedAccount}`
                            : `Synced ${completedSyncs.length} Vinted session${completedSyncs.length === 1 ? "" : "s"}`,
                    );
                } else {
                    const issue = getSyncIssue(payload.results);
                    toast.warning(
                        issue?.error ||
                            issue?.reason ||
                            "No fresh Vinted browser session was found.",
                    );
                }
                void getAccountStatus().then((updated) => {
                    setStatus(updated);
                });
            }
        };

        window.addEventListener("message", handleMessage);
        window.postMessage(
            { type: "VINTRACK_EXTENSION_PING" },
            window.location.origin,
        );

        return () => window.removeEventListener("message", handleMessage);
    }, []);

    const handleLink = () => {
        if (!accessToken.trim()) {
            toast.error("Access token is required");
            return;
        }

        const wasLinked = status.linked;
        startTransition(async () => {
            const result = await linkVintedAccount(
                accessToken.trim(),
                targetDomain,
                refreshToken.trim() || undefined,
                phoneNumber.trim() || undefined,
            );
            if ("error" in result) {
                toast.error(result.error);
                return;
            }
            setAccessToken("");
            setRefreshToken("");
            setPhoneNumber("");
            setStatus({
                linked: true,
                status: "active",
                vinted_name: result.vinted_name,
                vinted_id: result.vinted_id,
                domain: result.domain,
                has_browser_session: result.has_browser_session,
                browser_linked: result.browser_linked,
                last_browser_sync: result.last_browser_sync,
                has_phone_number: result.has_phone_number,
                linked_at: new Date().toISOString(),
                last_check: new Date().toISOString(),
            });
            toast.success(
                wasLinked
                    ? `Session updated for @${result.vinted_name}`
                    : `Linked to @${result.vinted_name}`,
            );
        });
    };

    const handleUnlink = () => {
        startTransition(async () => {
            const result = await unlinkVintedAccount();
            if (result.error) {
                toast.error(result.error);
                return;
            }
            setIsUnlinkDialogOpen(false);
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

    const handlePhoneUpdate = () => {
        startTransition(async () => {
            const result = await updateVintedPhoneNumber(
                linkedPhoneNumber.trim(),
            );
            if ("error" in result) {
                toast.error(result.error);
                return;
            }
            setStatus((current) => ({
                ...current,
                has_phone_number: result.has_phone_number,
                last_check: result.last_check,
            }));
            if (result.has_phone_number) {
                setLinkedPhoneNumber("");
                toast.success("Shipping phone number saved");
            } else {
                toast.success("Shipping phone number cleared");
            }
        });
    };

    const handleDomainUpdate = () => {
        startTransition(async () => {
            const result = await updateVintedDomain(targetDomain);
            if ("error" in result) {
                toast.error(result.error);
                return;
            }
            setStatus((current) => ({
                ...current,
                domain: result.domain,
                last_check: result.last_check,
            }));
            toast.success(`Primary Vinted region set to ${result.domain}`);

            if (extensionInstalled && !extensionUpdateRequired) {
                window.postMessage(
                    {
                        type: "VINTRACK_EXTENSION_MANUAL_SYNC",
                        payload: {
                            preferredDomain: result.domain,
                        },
                    },
                    window.location.origin,
                );
            }
        });
    };

    const handleBrowserSyncStart = async () => {
        if (extensionUpdateRequired) {
            toast.error(
                `Update the browser extension to v${minimumExtensionVersion} or newer first.`,
            );
            return;
        }
        setIsBrowserSyncStarting(true);

        try {
            const res = await fetch("/api/account/browser-link", {
                method: "POST",
                cache: "no-store",
            });
            const data = (await res.json()) as BrowserSyncState & {
                error?: string;
            };

            if (!res.ok) {
                throw new Error(data.error || `Request failed (${res.status})`);
            }

            setBrowserSync(data);
            if (!extensionInstalled) {
                setIsBrowserSyncStarting(false);
                toast.error(extensionNotDetectedMessage());
                return;
            }

            window.postMessage(
                {
                    type: "VINTRACK_EXTENSION_CONNECT",
                    payload: {
                        token: data.token,
                        appOrigin: window.location.origin,
                        preferredDomain: targetDomain,
                    },
                },
                window.location.origin,
            );
        } catch (error) {
            setIsBrowserSyncStarting(false);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to connect extension",
            );
        }
    };

    const handleManualExtensionSync = () => {
        if (!extensionInstalled) {
            toast.error(extensionNotDetectedMessage());
            return;
        }
        if (extensionUpdateRequired) {
            toast.error(
                `Update the browser extension to v${minimumExtensionVersion} or newer first.`,
            );
            return;
        }

        window.postMessage(
            {
                type: "VINTRACK_EXTENSION_MANUAL_SYNC",
                payload: {
                    preferredDomain: targetDomain,
                },
            },
            window.location.origin,
        );
    };

    const extensionUpdateRequired =
        extensionInstalled &&
        (!extensionVersion ||
            compareExtensionVersions(
                extensionVersion,
                minimumExtensionVersion,
            ) < 0);
    const extensionUpdateAvailable =
        extensionInstalled &&
        Boolean(extensionVersion) &&
        !extensionUpdateRequired &&
        compareExtensionVersions(
            extensionVersion || "0",
            latestExtensionVersion,
        ) < 0;
    const extensionReady =
        extensionInstalled && extensionConfigured && !extensionUpdateRequired;
    const extensionStatusTitle = !extensionInstalled
        ? "Extension not detected"
        : extensionUpdateRequired
          ? "Extension update required"
          : extensionUpdateAvailable
            ? "Extension update available"
            : extensionConfigured
              ? "Extension connected"
              : "Extension detected";
    const extensionStatusCopy = !extensionInstalled
        ? "Install the browser extension, reload this page, then connect it here."
        : extensionUpdateRequired
          ? `Version ${extensionVersion ? `v${extensionVersion}` : "legacy"} is no longer supported. Install v${minimumExtensionVersion} or newer.`
          : extensionUpdateAvailable
            ? `Version v${latestExtensionVersion} is available. Your current version v${extensionVersion} remains supported.`
            : extensionConfigured
              ? "This browser can refresh the saved Vinted session automatically."
              : "Connect this browser once to start automatic Vinted session sync.";
    const lastBrowserSyncLabel =
        status.last_browser_sync || browserSync?.last_used_at
            ? formatSessionTimestamp(
                  status.last_browser_sync || browserSync?.last_used_at,
              )
            : "not synced yet";

    return (
        <div className="space-y-4">
            <Card className="border-border/70 gap-0 overflow-hidden py-0 shadow-sm">
                <CardHeader className="gap-4 border-b p-5 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <CardTitle className="text-base">
                            Browser Extension
                        </CardTitle>
                        <CardDescription>
                            Keep Vintrack supplied with a fresh Vinted browser
                            session from this device.
                        </CardDescription>
                    </div>
                    <div
                        className={cn(
                            "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium",
                            extensionUpdateRequired
                                ? "border-destructive/30 bg-destructive/10 text-destructive"
                                : extensionReady
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                                  : extensionInstalled
                                    ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                                    : "border-border bg-muted/40 text-muted-foreground",
                        )}
                    >
                        {extensionUpdateRequired ? (
                            <AlertCircle className="h-4 w-4" />
                        ) : extensionReady ? (
                            <CheckCircle2 className="h-4 w-4" />
                        ) : extensionInstalled ? (
                            <Cable className="h-4 w-4" />
                        ) : (
                            <AlertCircle className="h-4 w-4" />
                        )}
                        {extensionStatusTitle}
                    </div>
                </CardHeader>
                <CardContent className="space-y-4 p-5">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="border-border/70 bg-muted/20 rounded-lg border p-3">
                            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                Browser
                            </p>
                            <p className="mt-1 text-sm font-medium">
                                {extensionInstalled ? "Detected" : "Missing"}
                            </p>
                        </div>
                        <div className="border-border/70 bg-muted/20 rounded-lg border p-3">
                            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                Connection
                            </p>
                            <p className="mt-1 text-sm font-medium">
                                {extensionConfigured
                                    ? "Connected"
                                    : "Not connected"}
                            </p>
                        </div>
                        <div className="border-border/70 bg-muted/20 rounded-lg border p-3">
                            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                Version
                            </p>
                            <p
                                className={cn(
                                    "mt-1 text-sm font-medium",
                                    extensionUpdateRequired &&
                                        "text-destructive",
                                )}
                            >
                                {!extensionInstalled
                                    ? "—"
                                    : extensionVersion
                                      ? `v${extensionVersion}`
                                      : "Legacy"}
                            </p>
                        </div>
                        <div className="border-border/70 bg-muted/20 rounded-lg border p-3">
                            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                Last browser sync
                            </p>
                            <p className="mt-1 text-sm font-medium">
                                {lastBrowserSyncLabel}
                            </p>
                        </div>
                    </div>

                    {extensionUpdateRequired ? (
                        <div className="border-destructive/30 bg-destructive/8 rounded-md border p-4">
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex gap-3">
                                    <AlertCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" />
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Browser extension update required
                                        </p>
                                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                                            Install v{minimumExtensionVersion}{" "}
                                            or newer to continue syncing.
                                            Extract the new ZIP over the old
                                            extension folder, then click Reload
                                            on{" "}
                                            <code className="text-foreground font-medium">
                                                chrome://extensions
                                            </code>
                                            .
                                        </p>
                                    </div>
                                </div>
                                <Button
                                    asChild
                                    size="sm"
                                    className="gap-2 sm:shrink-0"
                                >
                                    <a
                                        href={CHROME_EXTENSION_DOWNLOAD_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        <Download className="h-4 w-4" />
                                        Download v{latestExtensionVersion}
                                    </a>
                                </Button>
                            </div>
                        </div>
                    ) : extensionUpdateAvailable ? (
                        <div className="rounded-md border border-amber-300/60 bg-amber-500/8 p-4 dark:border-amber-500/30">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <p className="text-sm font-semibold">
                                        Extension v{latestExtensionVersion} is
                                        available
                                    </p>
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        Your installed v{extensionVersion} still
                                        works, but updating is recommended.
                                    </p>
                                </div>
                                <Button
                                    asChild
                                    variant="outline"
                                    size="sm"
                                    className="gap-2 sm:shrink-0"
                                >
                                    <a
                                        href={CHROME_EXTENSION_DOWNLOAD_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        <Download className="h-4 w-4" />
                                        Download update
                                    </a>
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    <div className="border-border/70 bg-muted/25 rounded-lg border p-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <div>
                                <p className="text-sm font-medium">
                                    {extensionStatusCopy}
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    Sign in to Vinted in this same browser. The
                                    extension syncs only the session token and
                                    the selected Vinted domain.
                                </p>
                            </div>
                            <Button
                                onClick={handleBrowserSyncStart}
                                disabled={
                                    isBrowserSyncStarting ||
                                    extensionUpdateRequired
                                }
                                className="gap-2 md:shrink-0"
                            >
                                {isBrowserSyncStarting ? (
                                    <RefreshCw className="h-4 w-4 animate-spin" />
                                ) : extensionConfigured ? (
                                    <RefreshCw className="h-4 w-4" />
                                ) : (
                                    <Bot className="h-4 w-4" />
                                )}
                                {extensionConfigured
                                    ? "Reconnect"
                                    : "Connect Extension"}
                            </Button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        <Button asChild variant="outline" className="gap-2">
                            <a
                                href={CHROME_EXTENSION_DOWNLOAD_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <Download className="h-4 w-4" />
                                Chrome Extension
                                <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                        </Button>
                        <Button asChild variant="outline" className="gap-2">
                            <a
                                href={firefoxExtensionUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <Download className="h-4 w-4" />
                                Firefox Add-ons
                                <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                        </Button>
                        {extensionInstalled ? (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleManualExtensionSync}
                                disabled={extensionUpdateRequired}
                                className="gap-2"
                            >
                                <RefreshCw className="h-4 w-4" />
                                Sync now
                            </Button>
                        ) : null}
                    </div>

                    {browserSync?.syncedDomains?.length ? (
                        <p className="text-muted-foreground text-xs">
                            Synced domains:{" "}
                            {browserSync.syncedDomains.join(", ")}
                        </p>
                    ) : null}
                </CardContent>
            </Card>

            {status.linked ? (
                <Card className="border-border/70 gap-0 overflow-hidden py-0 shadow-sm">
                    <CardHeader className="border-b p-5">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/20">
                                    <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                                </div>
                                <div>
                                    <CardTitle className="text-lg">
                                        @{status.vinted_name}
                                    </CardTitle>
                                    <CardDescription>
                                        Linked to {status.domain}
                                    </CardDescription>
                                </div>
                            </div>
                            <Badge
                                variant={
                                    status.status === "active"
                                        ? "default"
                                        : status.status === "degraded"
                                          ? "outline"
                                          : "destructive"
                                }
                            >
                                {sessionStatusLabel(status.status)}
                            </Badge>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-4 p-5">
                        {status.requires_browser_reauth ||
                        status.requires_browser_sync ||
                        status.status === "degraded" ? (
                            <div className="border-border/80 bg-muted/40 rounded-md border p-3 text-sm">
                                <p className="font-medium">
                                    {status.requires_browser_sync
                                        ? "Vintrack is still linked. The browser extension is refreshing the Vinted session automatically; sign in to Vinted in this browser if requested."
                                        : status.requires_browser_reauth
                                          ? "Update the saved Vinted session to restore account access."
                                          : "Vintrack is retrying session validation automatically."}
                                </p>
                                {status.invalid_reason ? (
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        Reason: {status.invalid_reason}
                                    </p>
                                ) : null}
                            </div>
                        ) : null}
                        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-2 text-sm">
                            <span>
                                Last browser sync:{" "}
                                <strong className="text-foreground font-medium">
                                    {formatSessionTimestamp(
                                        status.last_browser_sync,
                                    )}
                                </strong>
                            </span>
                            <span>
                                Last valid:{" "}
                                <strong className="text-foreground font-medium">
                                    {formatSessionTimestamp(
                                        status.last_valid_at ||
                                            status.last_check,
                                    )}
                                </strong>
                            </span>
                            <span>
                                Last refresh:{" "}
                                <strong className="text-foreground font-medium">
                                    {formatSessionTimestamp(
                                        status.last_refresh_at,
                                    )}
                                </strong>
                            </span>
                            <span>
                                Browser refresh:{" "}
                                <strong className="text-foreground font-medium">
                                    {status.browser_linked
                                        ? "not copied"
                                        : status.has_refresh_token
                                          ? "saved"
                                          : "missing"}
                                </strong>
                            </span>
                            {status.browser_linked ? (
                                <span>
                                    Browser grant:{" "}
                                    <strong className="text-foreground font-medium">
                                        {status.browser_link_connected
                                            ? "connected"
                                            : "reconnect extension"}
                                    </strong>
                                </span>
                            ) : null}
                            <span>
                                Phone:{" "}
                                <strong className="text-foreground font-medium">
                                    {status.has_phone_number
                                        ? "saved"
                                        : "not set"}
                                </strong>
                            </span>
                            {status.vinted_id ? (
                                <span className="inline-flex items-center gap-1">
                                    ID:{" "}
                                    <strong className="text-foreground font-medium">
                                        {isVintedIdVisible
                                            ? status.vinted_id
                                            : "hidden"}
                                    </strong>
                                    <button
                                        onClick={() =>
                                            setIsVintedIdVisible(
                                                (prev) => !prev,
                                            )
                                        }
                                        className="text-muted-foreground hover:text-foreground rounded p-0.5"
                                        type="button"
                                    >
                                        {isVintedIdVisible ? (
                                            <EyeOff className="h-3.5 w-3.5" />
                                        ) : (
                                            <Eye className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                </span>
                            ) : null}
                        </div>

                        <div className="border-border/70 bg-muted/20 rounded-lg border p-4 text-sm">
                            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                Primary Region
                            </span>
                            <p className="text-muted-foreground mt-1 text-xs">
                                Checkout starts here first. Other synced regions
                                no longer overwrite this setting.
                            </p>
                            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
                                {REGIONS.slice(0, 12).map((region) => {
                                    const isSelected =
                                        selectedRegion === region.code;
                                    return (
                                        <button
                                            key={region.code}
                                            type="button"
                                            onClick={() =>
                                                setSelectedRegion(region.code)
                                            }
                                            className={cn(
                                                "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                                                isSelected
                                                    ? "border-primary bg-primary text-primary-foreground"
                                                    : "border-border bg-background hover:bg-muted",
                                            )}
                                        >
                                            <span>{region.flag}</span>
                                            <span>
                                                {region.code.toUpperCase()}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                                <p className="text-muted-foreground text-xs">
                                    Current: {status.domain || "—"} · Selected:{" "}
                                    {targetDomain}
                                </p>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleDomainUpdate}
                                    disabled={
                                        isPending ||
                                        status.domain === targetDomain
                                    }
                                    className="sm:ml-auto"
                                >
                                    Save Region
                                </Button>
                            </div>
                        </div>

                        <div className="border-border/70 bg-muted/20 rounded-lg border p-4 text-sm">
                            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                                Shipping Contact
                            </span>
                            <p className="mt-1 font-medium">
                                {status.has_phone_number
                                    ? "Phone number stored for checkout"
                                    : "No phone number stored"}
                            </p>
                            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                                <Input
                                    value={linkedPhoneNumber}
                                    onChange={(e) =>
                                        setLinkedPhoneNumber(e.target.value)
                                    }
                                    type="tel"
                                    inputMode="tel"
                                    autoComplete="new-password"
                                    name="vintrack-shipping-phone"
                                    placeholder="Set or clear phone number, e.g. +491234567890"
                                    className="bg-background"
                                />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handlePhoneUpdate}
                                    disabled={isPending}
                                    className="sm:w-auto"
                                >
                                    Save
                                </Button>
                            </div>
                        </div>
                        <div className="xs:flex-row flex flex-col gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleRefresh}
                                disabled={isPending}
                                className="flex-1 gap-1.5 sm:flex-none"
                            >
                                <RefreshCw
                                    className={cn(
                                        "h-3.5 w-3.5",
                                        isPending && "animate-spin",
                                    )}
                                />
                                Refresh
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setIsUnlinkDialogOpen(true)}
                                disabled={isPending}
                                className="flex-1 gap-1.5 border-red-200 text-red-600 hover:bg-red-50 sm:flex-none dark:border-red-500/20 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10"
                            >
                                <Unlink className="h-3.5 w-3.5" />
                                Unlink Account
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : null}

            {status.linked ? (
                <Card className="border-border/70 gap-0 overflow-hidden py-0 shadow-sm">
                    <details className="group">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium">
                            Manual repair
                            <span className="text-muted-foreground text-xs font-normal group-open:hidden">
                                Optional
                            </span>
                        </summary>
                        <CardContent className="space-y-4 px-5 pb-5">
                            <p className="text-muted-foreground text-sm">
                                Use this only if the extension cannot sync the
                                current browser session.
                            </p>

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="repair-access-token">
                                        Access Token
                                    </Label>
                                    <Input
                                        id="repair-access-token"
                                        type="password"
                                        placeholder="access_token_web"
                                        value={accessToken}
                                        onChange={(e) =>
                                            setAccessToken(e.target.value)
                                        }
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="repair-refresh-token">
                                        Refresh Token
                                    </Label>
                                    <Input
                                        id="repair-refresh-token"
                                        type="password"
                                        placeholder="refresh_token_web"
                                        value={refreshToken}
                                        onChange={(e) =>
                                            setRefreshToken(e.target.value)
                                        }
                                    />
                                </div>
                            </div>

                            <Button
                                onClick={handleLink}
                                disabled={isPending}
                                className="gap-2"
                            >
                                {isPending ? (
                                    <RefreshCw className="h-4 w-4 animate-spin" />
                                ) : (
                                    <LinkIcon className="h-4 w-4" />
                                )}
                                Update Session
                            </Button>
                        </CardContent>
                    </details>
                </Card>
            ) : (
                <Card className="border-border/70 gap-0 overflow-hidden py-0 shadow-sm">
                    <details className="group">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium">
                            Manual token link
                            <span className="text-muted-foreground text-xs font-normal group-open:hidden">
                                Fallback
                            </span>
                        </summary>
                        <CardContent className="space-y-5 px-5 pb-5">
                            <p className="text-muted-foreground text-sm">
                                Prefer the extension above. Use tokens only if
                                the extension is unavailable.
                            </p>

                            <div className="space-y-2">
                                <Label className="text-sm font-medium">
                                    Region
                                </Label>
                                <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
                                    {REGIONS.slice(0, 12).map((region) => {
                                        const isSelected =
                                            selectedRegion === region.code;
                                        return (
                                            <button
                                                key={region.code}
                                                type="button"
                                                onClick={() =>
                                                    setSelectedRegion(
                                                        region.code,
                                                    )
                                                }
                                                className={cn(
                                                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                                                    isSelected
                                                        ? "border-primary bg-primary text-primary-foreground"
                                                        : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                                                )}
                                            >
                                                <span className="shrink-0 text-sm">
                                                    {region.flag}
                                                </span>
                                                <span className="truncate">
                                                    {region.label}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="access-token">
                                        Access Token
                                    </Label>
                                    <Input
                                        id="access-token"
                                        type="password"
                                        placeholder="access_token_web"
                                        value={accessToken}
                                        onChange={(e) =>
                                            setAccessToken(e.target.value)
                                        }
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="refresh-token">
                                        Refresh Token
                                    </Label>
                                    <Input
                                        id="refresh-token"
                                        type="password"
                                        placeholder="refresh_token_web"
                                        value={refreshToken}
                                        onChange={(e) =>
                                            setRefreshToken(e.target.value)
                                        }
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="phone-number">
                                    Shipping Phone Number
                                </Label>
                                <Input
                                    id="phone-number"
                                    value={phoneNumber}
                                    onChange={(e) =>
                                        setPhoneNumber(e.target.value)
                                    }
                                    type="tel"
                                    inputMode="tel"
                                    autoComplete="tel"
                                    name="vintrack-shipping-phone"
                                    placeholder="Optional, e.g. +491234567890"
                                />
                            </div>

                            <Button
                                onClick={handleLink}
                                disabled={!accessToken.trim() || isPending}
                                className="gap-2"
                            >
                                {isPending ? (
                                    <RefreshCw className="h-4 w-4 animate-spin" />
                                ) : (
                                    <LinkIcon className="h-4 w-4" />
                                )}
                                Link Account
                            </Button>
                        </CardContent>
                    </details>
                </Card>
            )}

            <Dialog
                open={isUnlinkDialogOpen}
                onOpenChange={(open) => {
                    if (!isPending) {
                        setIsUnlinkDialogOpen(open);
                    }
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Unlink Vinted account?</DialogTitle>
                        <DialogDescription>
                            This removes the saved Vinted session from Vintrack.
                            You can link the account again with the browser
                            extension or manual tokens.
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setIsUnlinkDialogOpen(false)}
                            disabled={isPending}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={handleUnlink}
                            disabled={isPending}
                        >
                            {isPending ? "Unlinking..." : "Unlink Account"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
