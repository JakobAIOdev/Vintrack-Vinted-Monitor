"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
    LayoutDashboard,
    PlusCircle,
    Radio,
    LogOut,
    Globe,
    Shield,
    User,
    Star,
    BookOpen,
    X,
    Heart,
    MessageCircle,
    Store,
    Link2,
    TrendingDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { CreateMonitorLink } from "@/components/maintenance/create-monitor-link";
import type { FeatureAccessResult, FeatureKey } from "@/lib/features";
import {
    ACCOUNT_UPDATES_VERSION,
    checkoutFeatureDiscoverable,
} from "@/lib/account-updates";
import { markAccountUpdatesSeen } from "@/actions/account-updates";

const GITHUB_SPONSORS_URL = "https://github.com/sponsors/JakobAIOdev";

type NavItem = {
    href: string;
    label: string;
    icon: typeof LayoutDashboard;
    feature?: FeatureKey;
    experimental?: boolean;
};

const primaryNavItems: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    {
        href: "/price-watches",
        label: "Price Watch",
        icon: TrendingDown,
        feature: "price_watch",
    },
    { href: "/feed", label: "Live Feed", icon: Radio, feature: "live_feed" },
];

const accountNavItems: NavItem[] = [
    { href: "/account", label: "Account", icon: User },
    {
        href: "/your-listings",
        label: "Your Listings",
        icon: Store,
        feature: "your_listings",
    },
    {
        href: "/liked",
        label: "Liked Items",
        icon: Heart,
        feature: "liked_items",
    },
    { href: "/chats", label: "Chats", icon: MessageCircle, feature: "chats" },
];

const moreNavItems: NavItem[] = [
    { href: "/guide", label: "Guide", icon: BookOpen },
    {
        href: "/checkout-links",
        label: "Checkout Links",
        icon: Link2,
        experimental: true,
        feature: "checkout_links",
    },
];

const adminNavItems = [{ href: "/admin", label: "Admin Panel", icon: Shield }];

interface SidebarProps {
    user?: {
        id?: string;
        accountUpdatesSeenVersion?: number;
        name?: string | null;
        image?: string | null;
        email?: string | null;
        role?: string;
    };
    isOpen?: boolean;
    onClose?: () => void;
    features: Record<FeatureKey, FeatureAccessResult>;
}

export function Sidebar({ user, isOpen, onClose, features }: SidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const onAccount =
        pathname === "/account" || pathname.startsWith("/account/");
    const unseenAccountUpdates =
        Boolean(user?.id) &&
        (user?.accountUpdatesSeenVersion ?? 0) < ACCOUNT_UPDATES_VERSION;
    const showAccountBadge =
        unseenAccountUpdates &&
        !onAccount &&
        checkoutFeatureDiscoverable(features.checkout_links);
    useEffect(() => {
        if (!onAccount || !unseenAccountUpdates) return;
        // Visiting the page acknowledges the announcement only. Checkout and
        // payment consent are separate explicit actions.
        void markAccountUpdatesSeen()
            .then((result) => {
                if (result.success) router.refresh();
            })
            .catch(() => {});
    }, [onAccount, unseenAccountUpdates, router]);

    const initials = user?.name
        ? user.name
              .split(" ")
              .map((n) => n[0])
              .join("")
              .toUpperCase()
              .slice(0, 2)
        : "?";

    return (
        <aside
            className={cn(
                "border-sidebar-border/80 bg-sidebar/95 text-sidebar-foreground fixed top-0 bottom-0 left-0 z-50 flex h-full w-60 flex-col border-r backdrop-blur-xl transition-transform duration-300 lg:translate-x-0",
                isOpen ? "translate-x-0" : "-translate-x-full",
            )}
        >
            <div className="border-sidebar-border/80 flex h-14 items-center justify-between border-b px-5">
                <Link href="/dashboard" className="flex items-center gap-2">
                    <div className="bg-sidebar-primary text-sidebar-primary-foreground flex h-7 w-7 items-center justify-center rounded-lg shadow-sm">
                        <span className="text-xs font-semibold">V</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                        <span className="text-[15px] font-semibold">
                            Vintrack
                        </span>
                    </div>
                </Link>
                <button
                    onClick={onClose}
                    className="text-sidebar-foreground/55 hover:text-sidebar-foreground p-1 transition-colors lg:hidden"
                >
                    <X className="h-5 w-5" />
                </button>
            </div>

            <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
                <p className="text-sidebar-foreground/45 mb-1 px-3 text-xs font-medium">
                    Track
                </p>

                {primaryNavItems
                    .filter(
                        (item) =>
                            !item.feature || features[item.feature].allowed,
                    )
                    .map((item) => {
                        const isActive =
                            pathname === item.href ||
                            pathname.startsWith(item.href + "/");
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                onClick={onClose}
                                className={cn(
                                    "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                                    isActive
                                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                        : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                                )}
                            >
                                <item.icon
                                    className={cn(
                                        "h-4 w-4",
                                        isActive
                                            ? "text-sidebar-accent-foreground"
                                            : "text-sidebar-foreground/45",
                                    )}
                                />
                                {item.label}
                            </Link>
                        );
                    })}

                {features.proxy_groups.allowed ? (
                    <Link
                        href="/proxies"
                        onClick={onClose}
                        className={cn(
                            "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                            pathname === "/proxies" ||
                                pathname.startsWith("/proxies/")
                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        )}
                    >
                        <Globe
                            className={cn(
                                "h-4 w-4",
                                pathname === "/proxies" ||
                                    pathname.startsWith("/proxies/")
                                    ? "text-sidebar-accent-foreground"
                                    : "text-sidebar-foreground/45",
                            )}
                        />
                        Proxy Groups
                    </Link>
                ) : null}

                <div className="py-3">
                    <CreateMonitorLink
                        onClick={onClose}
                        className="border-sidebar-border/80 text-sidebar-foreground/68 hover:border-sidebar-foreground/20 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-2.5 rounded-lg border border-dashed px-3 py-2 text-[13px] font-medium transition-colors"
                    >
                        <PlusCircle className="text-sidebar-foreground/45 h-4 w-4" />
                        New Monitor
                    </CreateMonitorLink>
                </div>

                <div className="border-sidebar-border/60 border-t pt-3">
                    <p className="text-sidebar-foreground/45 mb-1 px-3 text-xs font-medium">
                        Account
                    </p>
                    <div className="space-y-0.5">
                        {accountNavItems
                            .filter(
                                (item) =>
                                    !item.feature ||
                                    features[item.feature].allowed,
                            )
                            .map((item) => {
                                const isActive =
                                    pathname === item.href ||
                                    pathname.startsWith(item.href + "/");
                                return (
                                    <Link
                                        key={item.href}
                                        href={item.href}
                                        onClick={onClose}
                                        className={cn(
                                            "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                                            isActive
                                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                                : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                                        )}
                                    >
                                        <item.icon
                                            className={cn(
                                                "h-4 w-4",
                                                isActive
                                                    ? "text-sidebar-accent-foreground"
                                                    : "text-sidebar-foreground/45",
                                            )}
                                        />
                                        {item.label}
                                        {item.href === "/account" &&
                                            showAccountBadge && (
                                                <span className="text-sidebar-foreground/55 ml-auto text-[11px]">
                                                    New
                                                </span>
                                            )}
                                    </Link>
                                );
                            })}
                    </div>
                </div>

                <div className="border-sidebar-border/60 mt-3 border-t pt-3">
                    <p className="text-sidebar-foreground/45 mb-1 px-3 text-xs font-medium">
                        Tools
                    </p>
                    <div className="space-y-0.5">
                        {moreNavItems
                            .filter(
                                (item) =>
                                    !item.feature ||
                                    features[item.feature].allowed,
                            )
                            .map((item) => {
                                const isActive =
                                    pathname === item.href ||
                                    pathname.startsWith(item.href + "/");
                                return (
                                    <Link
                                        key={item.href}
                                        href={item.href}
                                        onClick={onClose}
                                        className={cn(
                                            "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                                            isActive
                                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                                : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                                        )}
                                    >
                                        <item.icon
                                            className={cn(
                                                "h-4 w-4",
                                                isActive
                                                    ? "text-sidebar-accent-foreground"
                                                    : "text-sidebar-foreground/45",
                                            )}
                                        />
                                        <span className="truncate">
                                            {item.label}
                                        </span>
                                        {item.experimental && (
                                            <span
                                                className="text-sidebar-foreground/55 ml-auto shrink-0 text-[11px]"
                                                title="Experimental"
                                            >
                                                Exp
                                            </span>
                                        )}
                                    </Link>
                                );
                            })}
                    </div>
                </div>

                {user?.role === "admin" && (
                    <div className="pt-3">
                        <p className="text-sidebar-foreground/45 mb-1 px-3 text-xs font-medium">
                            Admin
                        </p>
                        {adminNavItems.map((item) => {
                            const isActive =
                                pathname === item.href ||
                                pathname.startsWith(item.href + "/");
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    onClick={onClose}
                                    className={cn(
                                        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                                        isActive
                                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                            : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                                    )}
                                >
                                    <item.icon
                                        className={cn(
                                            "h-4 w-4",
                                            isActive
                                                ? "text-sidebar-accent-foreground"
                                                : "text-sidebar-foreground/45",
                                        )}
                                    />
                                    {item.label}
                                </Link>
                            );
                        })}
                    </div>
                )}

                <div className="border-sidebar-border/60 mt-3 border-t pt-3">
                    <p className="text-sidebar-foreground/45 mb-1 px-3 text-xs font-medium">
                        Community
                    </p>
                    <div className="space-y-0.5">
                        <a
                            href="https://discord.gg/WbEpEjaWjP"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-blue-700 transition-colors hover:bg-blue-50 hover:text-blue-800 dark:text-blue-500 dark:hover:bg-blue-500/12 dark:hover:text-blue-400"
                        >
                            <MessageCircle className="h-4 w-4" />
                            Join Discord
                        </a>
                        <a
                            href="https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-amber-700 transition-colors hover:bg-amber-50 hover:text-amber-800 dark:text-amber-500 dark:hover:bg-amber-500/12 dark:hover:text-amber-400"
                        >
                            <Star className="h-4 w-4" />
                            Star on GitHub
                        </a>
                        <a
                            href={GITHUB_SPONSORS_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-pink-700 transition-colors hover:bg-pink-50 hover:text-pink-800 dark:text-pink-500 dark:hover:bg-pink-500/12 dark:hover:text-pink-400"
                        >
                            <Heart className="h-4 w-4" />
                            Sponsor Vintrack
                        </a>
                    </div>
                </div>
            </nav>

            <div className="border-sidebar-border/80 border-t p-3">
                <ThemeToggle className="mb-3" />
                <div className="flex items-center gap-2.5 px-2 py-1.5">
                    {user?.image ? (
                        <img
                            src={user.image}
                            alt=""
                            className="h-7 w-7 rounded-full"
                        />
                    ) : (
                        <div className="bg-sidebar-accent text-sidebar-accent-foreground flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-medium">
                            {initials}
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <p className="text-sidebar-foreground truncate text-[13px] font-medium">
                                {user?.name || "User"}
                            </p>
                            {user?.role === "premium" && (
                                <span className="text-sidebar-foreground/55 text-[11px]">
                                    Pro
                                </span>
                            )}
                            {user?.role === "admin" && (
                                <span className="text-sidebar-foreground/55 text-[11px]">
                                    Admin
                                </span>
                            )}
                        </div>
                    </div>
                    <Link
                        href="/logout"
                        className="text-sidebar-foreground/45 hover:text-sidebar-foreground p-1 transition-colors"
                        title="Sign out"
                    >
                        <LogOut className="h-3.5 w-3.5" />
                    </Link>
                </div>
                <div className="mt-2 flex justify-center px-2">
                    <p className="text-sidebar-foreground/45 font-mono text-[11px]">
                        Vintrack v{process.env.NEXT_PUBLIC_APP_VERSION}
                    </p>
                </div>
            </div>
        </aside>
    );
}
