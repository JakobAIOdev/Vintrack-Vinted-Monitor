"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    Bell,
    ChevronRight,
    ExternalLink,
    Github,
    Loader2,
    Menu,
    Star,
    Volume1,
    Volume2,
    VolumeX,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
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

    return new Intl.DateTimeFormat("de-DE", {
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
                event.data?.type !==
                    "VINTRACK_EXTENSION_MANUAL_SYNC_RESULT"
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
    const rootRef = useRef<HTMLDivElement | null>(null);

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
        if (loading || !linked) {
            setOpen(false);
            setNotifications([]);
            setHasLoaded(false);
            setLoadError(null);
        }
    }, [linked, loading]);

    useEffect(() => {
        if (!open) {
            return;
        }

        const handlePointerDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        document.addEventListener("mousedown", handlePointerDown);
        return () =>
            document.removeEventListener("mousedown", handlePointerDown);
    }, [open]);

    if (loading || !linked) {
        return null;
    }

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => {
                    const nextOpen = !open;
                    setOpen(nextOpen);
                    if (nextOpen && !hasLoaded) {
                        void fetchNotifications();
                    }
                }}
                className="border-border/80 bg-background/70 text-foreground hover:border-border hover:bg-accent hover:text-accent-foreground relative inline-flex h-8 w-8 items-center justify-center rounded-lg border shadow-sm transition-colors"
                aria-label="Open Vinted notifications"
            >
                <Bell className="h-4 w-4" />
                {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] leading-5 font-semibold text-white shadow-sm">
                        {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="border-border/70 bg-background/96 absolute top-11 right-0 z-50 w-88 overflow-hidden rounded-2xl border shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur-xl">
                    <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
                        <div>
                            <p className="text-foreground text-sm font-semibold">
                                Vinted Notifications
                            </p>
                            <p className="text-muted-foreground text-xs">
                                Your 5 most recent Notifications
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void fetchNotifications()}
                            disabled={isLoading}
                            className="text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-60"
                            aria-label="Refresh notifications"
                        >
                            <Loader2
                                className={cn(
                                    "h-4 w-4",
                                    isLoading && "animate-spin",
                                )}
                            />
                        </button>
                    </div>

                    <div className="max-h-104 overflow-y-auto p-2">
                        {isLoading && notifications.length === 0 ? (
                            <div className="space-y-2 p-2">
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
                                                alt="Notification"
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
                                            <p className="text-foreground max-h-15 overflow-hidden text-sm leading-5">
                                                {notification.body ||
                                                    "Neue Vinted-Benachrichtigung"}
                                            </p>
                                            <ExternalLink className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
                                        </div>
                                        <div className="mt-2 flex items-center gap-2">
                                            {notification.is_read === false && (
                                                <span className="inline-flex h-2 w-2 rounded-full bg-sky-500" />
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
                                    No Notifications found
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    As soon as you get a Notification it will be
                                    displayed here.
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

interface HeaderProps {
    onMenuClick?: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
    const pathname = usePathname();
    const { soundEnabled, soundReady, toggleSound } = useMonitorStreamContext();

    const getBreadcrumbs = (): { label: string; isCurrent: boolean }[] => {
        if (pathname === "/dashboard")
            return [{ label: "Dashboard", isCurrent: true }];
        if (pathname === "/monitors")
            return [{ label: "Monitors", isCurrent: true }];
        if (pathname === "/price-watches")
            return [{ label: "Price Watch", isCurrent: true }];
        if (pathname === "/proxies")
            return [{ label: "Proxy Groups", isCurrent: true }];
        if (pathname === "/feed")
            return [{ label: "Live Feed", isCurrent: true }];
        if (pathname === "/monitors/new")
            return [
                { label: "Monitors", isCurrent: false },
                { label: "Create", isCurrent: true },
            ];
        if (pathname.includes("/monitors/"))
            return [
                { label: "Monitors", isCurrent: false },
                { label: "Details", isCurrent: true },
            ];
        return [{ label: "Vintrack", isCurrent: true }];
    };

    const breadcrumbs = getBreadcrumbs();

    return (
        <header className="border-border/70 bg-background/72 sticky top-0 z-40 flex h-12 items-center justify-between border-b px-4 backdrop-blur-xl md:px-6">
            <div className="flex items-center gap-3">
                <button
                    onClick={onMenuClick}
                    className="text-muted-foreground hover:bg-accent hover:text-accent-foreground -ml-1.5 rounded-md p-1.5 transition-colors lg:hidden"
                >
                    <Menu className="h-5 w-5" />
                </button>

                <nav className="hidden items-center gap-1 text-sm sm:flex">
                    {breadcrumbs.map((crumb, i) => (
                        <span key={i} className="flex items-center gap-1">
                            {i > 0 && (
                                <ChevronRight className="text-muted-foreground/50 h-3.5 w-3.5" />
                            )}
                            <span
                                className={
                                    crumb.isCurrent
                                        ? "text-foreground font-medium"
                                        : "text-muted-foreground"
                                }
                            >
                                {crumb.label}
                            </span>
                        </span>
                    ))}
                </nav>
            </div>

            <div className="flex items-center gap-3 md:gap-4">
                <button
                    type="button"
                    onClick={() => void toggleSound()}
                    className={cn(
                        "border-border/80 bg-background/70 hover:border-border hover:bg-accent hover:text-accent-foreground inline-flex h-8 w-8 items-center justify-center rounded-lg border shadow-sm transition-colors",
                        soundEnabled
                            ? soundReady
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                    )}
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
                            <Volume2 className="h-4 w-4" />
                        ) : (
                            <Volume1 className="h-4 w-4" />
                        )
                    ) : (
                        <VolumeX className="h-4 w-4" />
                    )}
                </button>
                <NotificationBell />
                <ThemeToggle compact className="hidden sm:inline-flex" />
                <a
                    href="https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border-border/80 bg-card/70 text-muted-foreground hidden items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-800 sm:flex dark:hover:border-amber-500/30 dark:hover:bg-amber-500/10 dark:hover:text-amber-400"
                >
                    <Github className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">Star on GitHub</span>
                    <Star className="h-3.5 w-3.5" />
                </a>
                <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                    <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    <span className="xs:inline hidden">Connected</span>
                </div>
            </div>
        </header>
    );
}
