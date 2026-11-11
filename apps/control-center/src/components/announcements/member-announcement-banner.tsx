"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMonitorMaintenance } from "@/components/maintenance/monitor-maintenance-context";
import {
    AlertTriangle,
    ArrowRight,
    ExternalLink,
    Github,
    Info,
    Rocket,
    ShieldAlert,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    DEFAULT_MEMBER_ANNOUNCEMENT,
    isMemberAnnouncementVisible,
    type MemberAnnouncement,
    type MemberAnnouncementVariant,
} from "@/lib/member-announcement";
import {
    getMaintenanceAnnouncement,
    type MonitorMaintenance,
} from "@/lib/monitor-maintenance";

const LEGACY_SPONSOR_DISMISSAL_KEY =
    "vintrack:demo-server-upgrade-banner-dismissed:v1";

const variantStyles: Record<
    MemberAnnouncementVariant,
    {
        container: string;
        icon: string;
        button: string;
        Icon: typeof Rocket;
    }
> = {
    support: {
        container: "border-border bg-card text-card-foreground",
        icon: "bg-muted text-muted-foreground",
        button: "bg-primary text-primary-foreground hover:bg-primary/90",
        Icon: Rocket,
    },
    info: {
        container: "border-border bg-card text-card-foreground",
        icon: "bg-muted text-muted-foreground",
        button: "bg-primary text-primary-foreground hover:bg-primary/90",
        Icon: Info,
    },
    warning: {
        container: "border-border bg-card text-card-foreground",
        icon: "bg-muted text-amber-600 dark:text-amber-400",
        button: "bg-primary text-primary-foreground hover:bg-primary/90",
        Icon: AlertTriangle,
    },
    critical: {
        container: "border-border bg-card text-card-foreground",
        icon: "bg-muted text-red-600 dark:text-red-400",
        button: "bg-primary text-primary-foreground hover:bg-primary/90",
        Icon: ShieldAlert,
    },
};

function dismissalKey(revision: string) {
    return `vintrack:member-announcement:dismissed:${revision}`;
}

function isGithubUrl(url: string) {
    try {
        return new URL(url).hostname === "github.com";
    } catch {
        return false;
    }
}

export function MemberAnnouncementBanner({
    announcement,
    preview = false,
}: {
    announcement: MemberAnnouncement;
    preview?: boolean;
}) {
    const [dismissed, setDismissed] = useState(false);
    const [dismissalChecked, setDismissalChecked] = useState(
        preview || !announcement.dismissible,
    );
    const styles = variantStyles[announcement.variant];
    const Icon = styles.Icon;

    useEffect(() => {
        let active = true;
        queueMicrotask(() => {
            if (!active) return;
            if (preview || !announcement.dismissible) {
                setDismissed(false);
                setDismissalChecked(true);
                return;
            }

            let wasDismissed = false;
            try {
                wasDismissed =
                    window.localStorage.getItem(
                        dismissalKey(announcement.revision),
                    ) === "1" ||
                    (announcement.revision ===
                        DEFAULT_MEMBER_ANNOUNCEMENT.revision &&
                        window.localStorage.getItem(
                            LEGACY_SPONSOR_DISMISSAL_KEY,
                        ) === "1");
            } catch {}
            setDismissed(wasDismissed);
            setDismissalChecked(true);
        });

        return () => {
            active = false;
        };
    }, [announcement.dismissible, announcement.revision, preview]);

    const dismiss = () => {
        if (preview || !announcement.dismissible) return;
        setDismissed(true);
        try {
            window.localStorage.setItem(
                dismissalKey(announcement.revision),
                "1",
            );
            if (
                announcement.revision === DEFAULT_MEMBER_ANNOUNCEMENT.revision
            ) {
                window.localStorage.setItem(LEGACY_SPONSOR_DISMISSAL_KEY, "1");
            }
        } catch {}
    };

    if (!dismissalChecked || dismissed) return null;

    const ctaIcon = announcement.cta
        ? isGithubUrl(announcement.cta.url)
            ? Github
            : announcement.cta.url.startsWith("/")
              ? ArrowRight
              : ExternalLink
        : null;
    const CtaIcon = ctaIcon;
    const ctaClassName = cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors",
        styles.button,
    );
    const ctaContent = announcement.cta ? (
        <>
            {CtaIcon ? <CtaIcon className="h-3.5 w-3.5" /> : null}
            {announcement.cta.label}
        </>
    ) : null;

    return (
        <div
            role="status"
            data-announcement-variant={announcement.variant}
            data-announcement-revision={announcement.revision}
            className={cn(
                "flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center",
                styles.container,
            )}
        >
            <div className="flex min-w-0 flex-1 items-start gap-3">
                <div
                    className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        styles.icon,
                    )}
                >
                    <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-medium">{announcement.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-5 whitespace-pre-wrap sm:text-sm">
                        {announcement.message}
                    </p>
                </div>
            </div>

            {(announcement.cta || announcement.dismissible) && (
                <div className="flex shrink-0 items-start gap-2 pl-11 sm:pl-0">
                    {announcement.cta ? (
                        announcement.cta.url.startsWith("/") ? (
                            <Link
                                href={announcement.cta.url}
                                className={ctaClassName}
                                onClick={
                                    preview
                                        ? (event) => event.preventDefault()
                                        : undefined
                                }
                            >
                                {ctaContent}
                            </Link>
                        ) : (
                            <a
                                href={announcement.cta.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={ctaClassName}
                                onClick={
                                    preview
                                        ? (event) => event.preventDefault()
                                        : undefined
                                }
                            >
                                {ctaContent}
                            </a>
                        )
                    ) : null}
                    {announcement.dismissible ? (
                        <button
                            type="button"
                            onClick={dismiss}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            aria-label={
                                announcement.revision ===
                                DEFAULT_MEMBER_ANNOUNCEMENT.revision
                                    ? "Dismiss server upgrade notice"
                                    : "Dismiss announcement"
                            }
                            title={
                                preview
                                    ? "Dismissal disabled in preview"
                                    : "Dismiss"
                            }
                        >
                            <X className="h-4 w-4" />
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}

export function MemberAnnouncementHost({
    initialAnnouncement,
    role,
}: {
    initialAnnouncement: MemberAnnouncement;
    role?: string | null;
}) {
    const pathname = usePathname();
    const [announcement, setAnnouncement] = useState(initialAnnouncement);
    const { maintenance, setMaintenance } = useMonitorMaintenance();

    useEffect(() => {
        const controller = new AbortController();
        void fetch("/api/announcement", {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) return null;
                return (await response.json()) as {
                    announcement?: MemberAnnouncement;
                    maintenance?: MonitorMaintenance;
                };
            })
            .then((payload) => {
                if (payload?.announcement) {
                    setAnnouncement(payload.announcement);
                }
                if (payload?.maintenance) {
                    setMaintenance(payload.maintenance);
                }
            })
            .catch((error: unknown) => {
                if (error instanceof Error && error.name === "AbortError") {
                    return;
                }
                console.error("[announcement] failed to refresh", error);
            });

        return () => controller.abort();
    }, [pathname, setMaintenance]);

    const visibleAnnouncement = maintenance.enabled
        ? getMaintenanceAnnouncement(maintenance)
        : announcement;

    if (
        !isMemberAnnouncementVisible(visibleAnnouncement, {
            pathname,
            role,
        })
    ) {
        return null;
    }

    return (
        <div className="mb-6">
            <MemberAnnouncementBanner announcement={visibleAnnouncement} />
        </div>
    );
}
