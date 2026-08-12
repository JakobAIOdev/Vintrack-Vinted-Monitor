"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
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
    ExternalLink,
    Store,
    Link2,
    FlaskConical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { CreateMonitorLink } from "@/components/maintenance/create-monitor-link";

const ACCOUNT_SEEN_KEY = "vintrack:account-tab-seen";
const GITHUB_SPONSORS_URL = "https://github.com/sponsors/JakobAIOdev";
const SNEAKERDEV_REVIEW_URL =
    "https://www.sneakerdev.com/services/e9c9ec35-71a2-43b0-b93b-2c1e8bf2f84d-vintrack";

const navItems = [
    { href: "/dashboard", label: "Monitors", icon: LayoutDashboard },
    { href: "/feed", label: "Live Feed", icon: Radio },
    { href: "/proxies", label: "Proxy Groups", icon: Globe },
    { href: "/account", label: "Account", icon: User },
    { href: "/your-listings", label: "Your Listings", icon: Store },
    { href: "/liked", label: "Liked Items", icon: Heart },
    { href: "/chats", label: "Chats", icon: MessageCircle },
    { href: "/guide", label: "Guide", icon: BookOpen },
];

const experimentalNavItems = [
    { href: "/checkout-links", label: "Checkout Links", icon: Link2 },
];

const adminNavItems = [{ href: "/admin", label: "Admin Panel", icon: Shield }];

interface SidebarProps {
    user?: {
        name?: string | null;
        image?: string | null;
        email?: string | null;
        role?: string;
    };
    isOpen?: boolean;
    onClose?: () => void;
}

export function Sidebar({ user, isOpen, onClose }: SidebarProps) {
    const pathname = usePathname();
    const [showAccountBadge, setShowAccountBadge] = useState(() => {
        if (typeof window === "undefined") {
            return false;
        }

        return !localStorage.getItem(ACCOUNT_SEEN_KEY);
    });

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
                        <span className="text-xs font-bold">V</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                        <span className="text-[15px] font-semibold tracking-tight">
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

            <nav className="flex-1 space-y-0.5 px-3 pt-4">
                <p className="text-sidebar-foreground/40 mb-2 px-3 text-[11px] font-medium tracking-widest uppercase">
                    Navigation
                </p>

                {navItems.map((item) => {
                    const isActive =
                        pathname === item.href ||
                        pathname.startsWith(item.href + "/");
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            onClick={() => {
                                if (
                                    item.href === "/account" &&
                                    showAccountBadge
                                ) {
                                    localStorage.setItem(ACCOUNT_SEEN_KEY, "1");
                                    setShowAccountBadge(false);
                                }
                                onClose?.();
                            }}
                            className={cn(
                                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                                isActive
                                    ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                                    : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                            )}
                        >
                            <item.icon
                                className={cn(
                                    "h-4 w-4",
                                    isActive
                                        ? "text-sidebar-primary-foreground"
                                        : "text-sidebar-foreground/45",
                                )}
                            />
                            {item.label}
                            {item.href === "/account" && showAccountBadge && (
                                <span className="ml-auto rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase">
                                    New
                                </span>
                            )}
                        </Link>
                    );
                })}

                <div className="pt-4">
                    <CreateMonitorLink
                        onClick={onClose}
                        className="border-sidebar-border/80 text-sidebar-foreground/68 hover:border-sidebar-foreground/20 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-2.5 rounded-lg border border-dashed px-3 py-2 text-[13px] font-medium transition-colors"
                    >
                        <PlusCircle className="text-sidebar-foreground/45 h-4 w-4" />
                        New Monitor
                    </CreateMonitorLink>
                </div>

                <div className="pt-4">
                    <p className="text-sidebar-foreground/40 mb-2 px-3 text-[11px] font-medium tracking-widest uppercase">
                        Experimental
                    </p>
                    {experimentalNavItems.map((item) => {
                        const isActive =
                            pathname === item.href ||
                            pathname.startsWith(item.href + "/");
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                onClick={onClose}
                                className={cn(
                                    "mb-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                                    isActive
                                        ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                                        : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                                )}
                            >
                                <item.icon
                                    className={cn(
                                        "h-4 w-4",
                                        isActive
                                            ? "text-sidebar-primary-foreground"
                                            : "text-sidebar-foreground/45",
                                    )}
                                />
                                {item.label}
                                <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-amber-600 uppercase dark:text-amber-400">
                                    <FlaskConical className="h-2.5 w-2.5" />
                                    Exp
                                </span>
                            </Link>
                        );
                    })}
                </div>

                <div className="pt-4">
                    <p className="text-sidebar-foreground/40 mb-2 px-3 text-[11px] font-medium tracking-widest uppercase">
                        Community
                    </p>
                    <a
                        href="https://discord.gg/WbEpEjaWjP"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mb-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-blue-700 transition-colors hover:bg-blue-50 hover:text-blue-800 dark:text-blue-500 dark:hover:bg-blue-500/12 dark:hover:text-blue-400"
                    >
                        <MessageCircle className="h-4 w-4" />
                        Join Discord
                        <span className="rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase">
                            New
                        </span>
                        <ExternalLink className="ml-auto h-3.5 w-3.5 opacity-70" />
                    </a>
                    <a
                        href={SNEAKERDEV_REVIEW_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mb-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-500 dark:hover:bg-emerald-500/12 dark:hover:text-emerald-400"
                    >
                        <Star className="h-4 w-4" />
                        Review us
                        <ExternalLink className="ml-auto h-3.5 w-3.5 opacity-70" />
                    </a>
                    <a
                        href={GITHUB_SPONSORS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mb-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-pink-700 transition-colors hover:bg-pink-50 hover:text-pink-800 dark:text-pink-500 dark:hover:bg-pink-500/12 dark:hover:text-pink-400"
                    >
                        <Heart className="h-4 w-4" />
                        Sponsor Vintrack
                        <ExternalLink className="ml-auto h-3.5 w-3.5 opacity-70" />
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
                </div>

                {user?.role === "admin" && (
                    <div className="pt-4">
                        <p className="text-sidebar-foreground/40 mb-2 px-3 text-[11px] font-medium tracking-widest uppercase">
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
                                            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                                            : "text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                                    )}
                                >
                                    <item.icon
                                        className={cn(
                                            "h-4 w-4",
                                            isActive
                                                ? "text-sidebar-primary-foreground"
                                                : "text-sidebar-foreground/45",
                                        )}
                                    />
                                    {item.label}
                                </Link>
                            );
                        })}
                    </div>
                )}
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
                        <div className="bg-sidebar-accent text-sidebar-accent-foreground flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold">
                            {initials}
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <p className="text-sidebar-foreground truncate text-[13px] font-medium">
                                {user?.name || "User"}
                            </p>
                            {user?.role === "premium" && (
                                <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-amber-700 uppercase dark:bg-amber-500/15 dark:text-amber-400">
                                    Pro
                                </span>
                            )}
                            {user?.role === "admin" && (
                                <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-red-700 uppercase dark:bg-red-500/15 dark:text-red-400">
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
                    <p className="text-sidebar-foreground/40 text-[10px] font-medium">
                        Vintrack v{process.env.NEXT_PUBLIC_APP_VERSION}
                    </p>
                </div>
            </div>
        </aside>
    );
}
