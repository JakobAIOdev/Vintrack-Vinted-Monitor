"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    Bell,
    ChevronRight,
    ChevronLeft,
    ExternalLink,
    Menu,
    Volume1,
    Volume2,
    VolumeX,
    X,
    RefreshCw,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useVintedAccount } from "@/components/account-provider";
import { useMonitorStreamContext } from "@/components/monitors/monitor-stream-context";
import { cn } from "@/lib/utils";

type NotificationEntry = {
    id: string;
    body?: string;
    is_read?: boolean;
    url?: string;
    small_photo_url?: string;
    updated_at?: string;
};

function formatNotificationTime(value?: string) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return new Intl.DateTimeFormat(undefined, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

type NotificationsPayload = {
    notifications?: NotificationEntry[];
    error?: string;
    code?: string;
};

async function requestBrowserSessionSync(
    preferredDomain: string | null,
): Promise<boolean> {
    if (typeof window === "undefined") return false;

    return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
            window.removeEventListener("message", handleMessage);
            resolve(false);
        }, 45_000);

        function handleMessage(event: MessageEvent) {
            if (
                event.source !== window ||
                event.data?.type !== "VINTRACK_EXTENSION_MANUAL_SYNC_RESULT"
            ) {
                return;
            }
            window.clearTimeout(timeout);
            window.removeEventListener("message", handleMessage);
            resolve(Boolean(event.data.payload?.ok));
        }

        window.addEventListener("message", handleMessage);
        window.postMessage(
            {
                type: "VINTRACK_EXTENSION_MANUAL_SYNC",
                payload: { preferredDomain: preferredDomain || "" },
            },
            window.location.origin,
        );
    });
}

function NotificationBell() {
    const { linked, loading, domain } = useVintedAccount();
    const [open, setOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [notifications, setNotifications] = useState<NotificationEntry[]>([]);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const unreadCount = useMemo(
        () => notifications.filter((entry) => entry.is_read === false).length,
        [notifications],
    );

    const fetchNotifications = useCallback(async () => {
        if (!linked) {
            setNotifications([]);
            setHasLoaded(true);
            return;
        }

        const requestNotifications = async () => {
            const response = await fetch(
                "/api/notifications?page=1&per_page=5",
                { cache: "no-store" },
            );
            const data = (await response.json()) as NotificationsPayload;
            return { response, data };
        };

        setIsLoading(true);
        setLoadError(null);
        try {
            let result = await requestNotifications();
            if (
                !result.response.ok &&
                result.data.code === "vinted_session_refresh_required"
            ) {
                const synced = await requestBrowserSessionSync(domain);
                if (synced) {
                    result = await requestNotifications();
                }
            }

            if (!result.response.ok) {
                setLoadError(
                    result.data.error ||
                        "Vinted notifications are temporarily unavailable.",
                );
                setNotifications([]);
                setHasLoaded(true);
                return;
            }

            setNotifications(
                Array.isArray(result.data.notifications)
                    ? result.data.notifications
                    : [],
            );
            setHasLoaded(true);
        } catch {
            setLoadError("Vinted notifications are temporarily unavailable.");
            setNotifications([]);
            setHasLoaded(true);
        } finally {
            setIsLoading(false);
        }
    }, [domain, linked]);

    useEffect(() => {
        if (!loading && linked) {
            void fetchNotifications();
        }
    }, [fetchNotifications, linked, loading]);

    useEffect(() => {
        if (loading || !linked) return;
        const params = new URLSearchParams(window.location.search);
        if (params.get("notifications") !== "1") return;

        params.delete("notifications");
        const query = params.toString();
        window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
        );
        setOpen(true);
        void fetchNotifications();
    }, [fetchNotifications, linked, loading]);

    useEffect(() => {
        if (loading || !linked) {
            setOpen(false);
            setNotifications([]);
            setHasLoaded(false);
            setLoadError(null);
        }
    }, [linked, loading]);

    if (loading || !linked) {
        return null;
    }

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    onClick={() => {
                        if (!open && !hasLoaded) {
                            void fetchNotifications();
                        }
                    }}
                    className="border-border bg-card text-foreground hover:bg-accent relative inline-flex h-[44px] w-[44px] items-center justify-center rounded-lg border transition-colors"
                    aria-label="Open Vinted notifications"
                >
                    <Bell className="h-4 w-4" />
                    {unreadCount > 0 && (
                        <span className="absolute -top-1 -right-1 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] leading-5 font-semibold text-white shadow-sm">
                            {unreadCount > 9 ? "9+" : unreadCount}
                        </span>
                    )}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="end"
                    sideOffset={8}
                    collisionPadding={12}
                    aria-label="Vinted notifications"
                    className="dashboard-popover border-border bg-card text-foreground z-50 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border shadow-lg outline-none"
                >
                    <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
                        <div>
                            <p className="text-foreground text-sm font-semibold">
                                Vinted Notifications
                            </p>
                            <p className="text-muted-foreground text-xs">
                                Your 5 most recent notifications
                            </p>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => void fetchNotifications()}
                                disabled={isLoading}
                                className="text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-60"
                                aria-label="Refresh notifications"
                            >
                                <RefreshCw
                                    className={cn(
                                        "h-4 w-4",
                                        isLoading &&
                                            "animate-spin motion-reduce:animate-none",
                                    )}
                                />
                            </button>
                            <Popover.Close
                                aria-label="Close notifications"
                                className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-9 items-center justify-center rounded-lg"
                            >
                                <X className="size-4" />
                            </Popover.Close>
                        </div>
                    </div>

                    <div
                        className="max-h-[min(26rem,var(--radix-popover-content-available-height))] overflow-y-auto p-2"
                        aria-busy={isLoading}
                    >
                        {isLoading && notifications.length === 0 ? (
                            <div className="space-y-2 p-2" role="status">
                                <span className="sr-only">
                                    Loading notifications
                                </span>
                                {Array.from({ length: 4 }).map((_, index) => (
                                    <div
                                        key={index}
                                        className="bg-muted h-18 animate-pulse rounded-2xl"
                                    />
                                ))}
                            </div>
                        ) : loadError ? (
                            <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                                <div className="bg-muted text-muted-foreground mb-3 flex h-12 w-12 items-center justify-center rounded-full">
                                    <Bell className="h-5 w-5" />
                                </div>
                                <p className="text-foreground text-sm font-medium">
                                    Notifications unavailable
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    {loadError}
                                </p>
                                <Link
                                    href="/account"
                                    className="text-primary mt-3 text-xs font-medium hover:underline"
                                >
                                    Open account settings
                                </Link>
                                <button
                                    type="button"
                                    onClick={() => void fetchNotifications()}
                                    className="text-foreground hover:bg-accent mt-3 min-h-11 rounded-lg border px-4 text-sm font-medium"
                                >
                                    Try again
                                </button>
                            </div>
                        ) : notifications.length > 0 ? (
                            notifications.map((notification) => (
                                <a
                                    key={notification.id}
                                    href={notification.url || undefined}
                                    target={
                                        notification.url ? "_blank" : undefined
                                    }
                                    rel={
                                        notification.url
                                            ? "noopener noreferrer"
                                            : undefined
                                    }
                                    className={cn(
                                        "hover:bg-accent/70 flex gap-3 rounded-2xl px-3 py-3 transition-colors",
                                        notification.is_read === false &&
                                            "bg-accent/35",
                                    )}
                                >
                                    <div className="bg-muted h-14 w-14 shrink-0 overflow-hidden rounded-2xl">
                                        {notification.small_photo_url ? (
                                            <img
                                                src={
                                                    notification.small_photo_url
                                                }
                                                alt=""
                                                className="h-full w-full object-cover"
                                            />
                                        ) : (
                                            <div className="text-muted-foreground flex h-full w-full items-center justify-center">
                                                <Bell className="h-4 w-4" />
                                            </div>
                                        )}
                                    </div>

                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-start justify-between gap-3">
                                            <p className="text-foreground text-sm leading-5 [overflow-wrap:anywhere]">
                                                {notification.body ||
                                                    "Vinted notification"}
                                            </p>
                                            <ExternalLink className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
                                        </div>
                                        <div className="mt-2 flex items-center gap-2">
                                            {notification.is_read === false && (
                                                <span className="text-foreground text-[11px] font-semibold">
                                                    Unread
                                                </span>
                                            )}
                                            <span className="text-muted-foreground text-[11px]">
                                                {formatNotificationTime(
                                                    notification.updated_at,
                                                )}
                                            </span>
                                        </div>
                                    </div>
                                </a>
                            ))
                        ) : (
                            <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                                <div className="bg-muted text-muted-foreground mb-3 flex h-12 w-12 items-center justify-center rounded-full">
                                    <Bell className="h-5 w-5" />
                                </div>
                                <p className="text-foreground text-sm font-medium">
                                    No notifications yet
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    New Vinted notifications will appear here.
                                </p>
                            </div>
                        )}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

interface HeaderProps {
    onMenuClick?: () => void;
    menuOpen?: boolean;
}

export function Header({ onMenuClick, menuOpen = false }: HeaderProps) {
    const pathname = usePathname();
    const { soundEnabled, soundReady, toggleSound, connectionStatus } =
        useMonitorStreamContext();
    const pages: Record<string, string> = {
        "/dashboard": "Monitors",
        "/monitors": "Monitors",
        "/price-watches": "Price Watch",
        "/proxies": "Proxy Groups",
        "/feed": "Live Feed",
        "/account": "Account",
        "/your-listings": "Your Listings",
        "/liked": "Liked Items",
        "/chats": "Chats",
        "/guide": "Guide",
        "/checkout-links": "Checkout Links",
        "/admin": "Admin Panel",
        "/oneclick-buy-test": "Checkout Test",
    };
    const crumbs: { label: string; href?: string }[] = [];
    if (pathname.startsWith("/monitors/")) {
        crumbs.push({ label: "Monitors", href: "/dashboard" });
        if (pathname === "/monitors/new") crumbs.push({ label: "New Monitor" });
        else if (pathname.endsWith("/edit")) {
            crumbs.push(
                { label: "Details", href: pathname.replace(/\/edit$/, "") },
                { label: "Edit Monitor" },
            );
        } else crumbs.push({ label: "Monitor Details" });
    } else if (pathname.startsWith("/admin/")) {
        crumbs.push(
            { label: "Admin Panel", href: "/admin" },
            {
                label:
                    pathname.split("/").pop()?.replaceAll("-", " ") || "Admin",
            },
        );
    } else crumbs.push({ label: pages[pathname] || "Vintrack" });
    const connectionLabel =
        connectionStatus === "live"
            ? "Live updates"
            : connectionStatus === "reconnecting"
              ? "Reconnecting"
              : "Connecting";

    return (
        <header className="dashboard-header border-border bg-card sticky top-0 z-40 flex min-h-14 min-w-0 items-center justify-between gap-3 border-b px-4 md:px-6">
            <div className="flex min-w-0 items-center gap-2">
                <button
                    type="button"
                    onClick={onMenuClick}
                    aria-label="Open navigation"
                    aria-controls="mobile-navigation"
                    aria-expanded={menuOpen}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground -ml-2 flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-lg lg:hidden"
                >
                    <Menu className="size-[20px]" />
                </button>
                <nav
                    aria-label="Breadcrumb"
                    className="flex min-w-0 items-center gap-1 text-[min(0.875rem,18px)]"
                >
                    {crumbs.map((crumb, index) => (
                        <span
                            key={crumb.label}
                            className={cn(
                                "min-w-0 items-center gap-1",
                                crumb.href && index > 0
                                    ? "hidden sm:flex"
                                    : "flex",
                            )}
                        >
                            {index > 0 && (
                                <ChevronRight
                                    aria-hidden="true"
                                    className="text-muted-foreground hidden size-3.5 shrink-0 sm:block"
                                />
                            )}
                            {crumb.href ? (
                                <Link
                                    href={crumb.href}
                                    className="text-muted-foreground hover:text-foreground rounded-md px-1 py-2 hover:underline"
                                >
                                    {index === 0 && (
                                        <ChevronLeft
                                            aria-hidden="true"
                                            className="size-5 sm:hidden"
                                        />
                                    )}
                                    <span
                                        className={
                                            index === 0
                                                ? "sr-only sm:not-sr-only"
                                                : undefined
                                        }
                                    >
                                        {crumb.label}
                                    </span>
                                </Link>
                            ) : (
                                <span
                                    aria-current="page"
                                    className="text-foreground truncate font-medium"
                                >
                                    {crumb.label}
                                </span>
                            )}
                        </span>
                    ))}
                </nav>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <span
                    role="status"
                    aria-label={connectionLabel}
                    className="text-muted-foreground flex items-center gap-2 text-xs"
                >
                    <span
                        aria-hidden="true"
                        className={cn(
                            "size-2 rounded-full",
                            connectionStatus === "live"
                                ? "bg-emerald-600 dark:bg-emerald-400"
                                : "bg-amber-600 dark:bg-amber-400",
                        )}
                    />
                    <span className="hidden md:inline">{connectionLabel}</span>
                </span>
                <button
                    type="button"
                    onClick={() => void toggleSound()}
                    className="border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground flex h-[44px] w-[44px] items-center justify-center rounded-lg border transition-colors"
                    aria-label={
                        soundEnabled
                            ? soundReady
                                ? "Disable item alert sound"
                                : "Activate item alert sound"
                            : "Enable item alert sound"
                    }
                    aria-pressed={soundEnabled}
                    title={
                        soundEnabled
                            ? soundReady
                                ? "Item alert sound on"
                                : "Click to activate item alert sound"
                            : "Item alert sound off"
                    }
                >
                    {soundEnabled ? (
                        soundReady ? (
                            <Volume2 className="size-4" />
                        ) : (
                            <Volume1 className="size-4" />
                        )
                    ) : (
                        <VolumeX className="size-4" />
                    )}
                </button>
                <NotificationBell />
            </div>
        </header>
    );
}
