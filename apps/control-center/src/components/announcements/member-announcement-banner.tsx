"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
        container:
            "border-pink-200/80 bg-gradient-to-r from-pink-50 via-amber-50/80 to-orange-50/70 text-slate-900 dark:border-pink-500/20 dark:from-pink-500/10 dark:via-amber-500/8 dark:to-orange-500/6 dark:text-slate-100",
        icon: "bg-pink-500 text-white shadow-pink-500/20",
        button: "bg-slate-950 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200",
        Icon: Rocket,
    },
    info: {
        container:
            "border-sky-200/90 bg-gradient-to-r from-sky-50 via-blue-50/70 to-indigo-50/60 text-slate-900 dark:border-sky-500/25 dark:from-sky-500/12 dark:via-blue-500/8 dark:to-indigo-500/6 dark:text-slate-100",
        icon: "bg-sky-500 text-white shadow-sky-500/20",
        button: "bg-sky-600 text-white hover:bg-sky-700 dark:bg-sky-400 dark:text-slate-950 dark:hover:bg-sky-300",
        Icon: Info,
    },
    warning: {
        container:
            "border-amber-200/90 bg-gradient-to-r from-amber-50 via-yellow-50/75 to-orange-50/60 text-slate-900 dark:border-amber-500/25 dark:from-amber-500/12 dark:via-yellow-500/8 dark:to-orange-500/6 dark:text-slate-100",
        icon: "bg-amber-500 text-white shadow-amber-500/20",
        button: "bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-400 dark:text-slate-950 dark:hover:bg-amber-300",
        Icon: AlertTriangle,
    },
    critical: {
        container:
            "border-red-200/90 bg-gradient-to-r from-red-50 via-rose-50/75 to-orange-50/50 text-slate-900 dark:border-red-500/30 dark:from-red-500/14 dark:via-rose-500/9 dark:to-orange-500/5 dark:text-slate-100",
        icon: "bg-red-600 text-white shadow-red-600/20",
        button: "bg-red-600 text-white hover:bg-red-700 dark:bg-red-400 dark:text-slate-950 dark:hover:bg-red-300",
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
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold shadow-sm transition-colors",
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
                "flex flex-col gap-3 rounded-xl border px-3.5 py-3 shadow-sm sm:flex-row sm:items-center",
                styles.container,
            )}
        >
            <div className="flex min-w-0 flex-1 items-start gap-3">
                <div
                    className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm",
                        styles.icon,
                    )}
                >
                    <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-semibold">
                        {announcement.title}
                    </p>
                    <p className="mt-0.5 text-xs leading-5 whitespace-pre-wrap text-slate-600 sm:text-sm dark:text-slate-300">
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
                            className="text-slate-500 transition-colors hover:text-slate-950 dark:text-slate-400 dark:hover:text-white"
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
                };
            })
            .then((payload) => {
                if (payload?.announcement) {
                    setAnnouncement(payload.announcement);
                }
            })
            .catch((error: unknown) => {
                if (error instanceof Error && error.name === "AbortError") {
                    return;
                }
                console.error("[announcement] failed to refresh", error);
            });

        return () => controller.abort();
    }, [pathname]);

    if (
        !isMemberAnnouncementVisible(announcement, {
            pathname,
            role,
        })
    ) {
        return null;
    }

    return (
        <div className="mb-6">
            <MemberAnnouncementBanner announcement={announcement} />
        </div>
    );
}
