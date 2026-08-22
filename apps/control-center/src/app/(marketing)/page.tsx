import { auth } from "@/auth";
import { LogoMark, MarketingCta } from "@/components/marketing/marketing-shell";
import { Button } from "@/components/ui/button";
import { absoluteMarketingUrl, buildMarketingMetadata } from "@/lib/seo";
import {
    ArrowRight,
    Bell,
    CheckCircle2,
    CirclePause,
    CirclePlay,
    Github,
    Globe2,
    Heart,
    LayoutDashboard,
    MessageCircle,
    Package,
    PackageSearch,
    Pencil,
    Radio,
    Send,
    Server,
    ShieldCheck,
    ShoppingCart,
    SlidersHorizontal,
    Timer,
    User,
    Webhook,
    RefreshCw,
    type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export function generateMetadata() {
    return buildMarketingMetadata({
        title: "Vintrack – Open-Source Vinted Monitor & Fast Alerts",
        description:
            "Monitor new Vinted listings with precise filters, a live dashboard, Discord and Telegram alerts, price watches, or your own self-hosted stack.",
        path: "/",
    });
}

const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;

const navItems: Array<{ label: string; icon: LucideIcon }> = [
    { label: "Dashboard", icon: LayoutDashboard },
    { label: "Live feed", icon: Radio },
    { label: "Proxies", icon: Globe2 },
    { label: "Account", icon: User },
];

const monitors = [
    {
        name: "Nike Dunk Low",
        region: "France",
        delay: "1.5s",
        status: "Running",
        proxy: "Resi FR",
        items: "275",
        tags: ["Nike", "39", "Max 90 EUR"],
    },
    {
        name: "Polo Ralph Lauren",
        region: "Germany",
        delay: "2s",
        status: "Running",
        proxy: "ipv6",
        items: "86",
        tags: ["Ralph Lauren", "XL", "Shirts"],
    },
    {
        name: "Arc'teryx shell",
        region: "Netherlands",
        delay: "5s",
        status: "Paused",
        proxy: "webshare nl",
        items: "18",
        tags: ["Jackets", "M", "Under 160 EUR"],
    },
];

const features: Array<{
    icon: LucideIcon;
    title: string;
    copy: string;
}> = [
    {
        icon: Radio,
        title: "Fast monitors",
        copy: "Per-monitor delay, region, proxy group, filters, and notification channels are controlled from one place.",
    },
    {
        icon: Globe2,
        title: "Free starter pools",
        copy: "Try monitoring in ready regions before paying for proxies. Vintrack continuously validates and rotates the shared pool.",
    },
    {
        icon: PackageSearch,
        title: "Readable finds",
        copy: "Large previews show price, total price, size, rating, country, monitor name, and direct Vinted links.",
    },
    {
        icon: ShieldCheck,
        title: "Linked actions",
        copy: "Use your connected Vinted account to like items, message sellers, send offers, and prepare checkout.",
    },
];

const workflow = [
    {
        title: "Create precise monitors",
        copy: "Filter by keyword, region, category, brand, size, condition, price, country, proxy group, and query delay.",
    },
    {
        title: "Watch the live stream",
        copy: "New listings land in the feed immediately, with enough detail to decide without opening another tab.",
    },
    {
        title: "Move from alert to action",
        copy: "Discord, Telegram, Vinted links, likes, offers, and messages stay close to the find.",
    },
];

function SectionHeader({
    kicker,
    title,
    copy,
}: {
    kicker: string;
    title: string;
    copy: string;
}) {
    return (
        <div className="max-w-2xl">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.2em] uppercase">
                {kicker}
            </p>
            <h2 className="text-foreground mt-3 text-3xl leading-tight font-semibold sm:text-4xl">
                {title}
            </h2>
            <p className="text-muted-foreground mt-4 text-sm leading-7 sm:text-base">
                {copy}
            </p>
        </div>
    );
}

function MockShell({
    children,
    className = "",
    active = "Dashboard",
    compact = false,
}: {
    children: ReactNode;
    className?: string;
    active?: string;
    compact?: boolean;
}) {
    return (
        <div
            className={`border-border bg-card text-card-foreground shadow-foreground/5 overflow-hidden rounded-lg border shadow-2xl ${className}`}
        >
            <div
                className={`bg-card flex ${compact ? "min-h-77.5" : "min-h-107.5"}`}
            >
                <aside className="border-border bg-muted/35 hidden w-44 shrink-0 border-r p-3 lg:block">
                    <div className="mb-7 flex items-center gap-2">
                        <LogoMark className="size-6" />
                        <div>
                            <p className="text-foreground text-xs font-semibold">
                                Vintrack
                            </p>
                            <p className="text-muted-foreground text-[10px]">
                                {appVersion
                                    ? `v${appVersion}`
                                    : "Control center"}
                            </p>
                        </div>
                    </div>
                    <nav className="space-y-1">
                        {navItems.map((item) => (
                            <div
                                key={item.label}
                                className={`flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium ${
                                    active === item.label
                                        ? "bg-foreground text-background"
                                        : "text-muted-foreground"
                                }`}
                            >
                                <item.icon className="size-3.5" />
                                {item.label}
                            </div>
                        ))}
                    </nav>
                    <div className="border-border text-muted-foreground mt-6 rounded-md border border-dashed px-2 py-2 text-xs font-medium">
                        + New monitor
                    </div>
                </aside>
                <div className="min-w-0 flex-1">{children}</div>
            </div>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="border-border bg-background/55 rounded-md border px-3 py-3">
            <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.14em] uppercase">
                {label}
            </p>
            <p className="text-foreground mt-1 text-xl font-semibold">
                {value}
            </p>
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const running = status === "Running";

    return (
        <span
            className={`inline-flex h-5 items-center gap-1.5 rounded-md px-2 text-[10px] font-semibold ${
                running
                    ? "border border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-border bg-muted text-muted-foreground border"
            }`}
        >
            {running ? (
                <span className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
            ) : null}
            {status}
        </span>
    );
}

function MonitorCard({ monitor }: { monitor: (typeof monitors)[number] }) {
    const running = monitor.status === "Running";

    return (
        <article className="border-border bg-background/60 hover:border-foreground/20 flex min-h-40 flex-col rounded-md border p-3 transition-colors">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-foreground truncate text-sm font-semibold">
                        {monitor.name}
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={monitor.status} />
                        <span className="text-muted-foreground text-[11px]">
                            {monitor.region}
                        </span>
                        <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
                            <Timer className="size-3" />
                            {monitor.delay}
                        </span>
                    </div>
                </div>
                <div className="text-muted-foreground flex gap-1">
                    <Pencil className="size-3.5" />
                    <Webhook className="size-3.5" />
                </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1">
                {monitor.tags.map((tag) => (
                    <span
                        key={tag}
                        className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                    >
                        {tag}
                    </span>
                ))}
            </div>

            <div className="text-muted-foreground mt-auto space-y-1.5 pt-4 text-[11px]">
                <div className="flex items-center gap-1.5">
                    <Package className="size-3.5" />
                    <span>
                        <strong className="text-foreground font-semibold">
                            {monitor.items}
                        </strong>{" "}
                        items found
                    </span>
                </div>
                <div className="flex items-center gap-1.5">
                    <Globe2 className="size-3.5" />
                    <span>{monitor.proxy}</span>
                </div>
            </div>

            <div className="border-border mt-3 flex items-center justify-between border-t pt-3">
                <span
                    className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                        running
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-emerald-600 dark:text-emerald-400"
                    }`}
                >
                    {running ? (
                        <CirclePause className="size-3.5" />
                    ) : (
                        <CirclePlay className="size-3.5" />
                    )}
                    {running ? "Pause" : "Resume"}
                </span>
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-semibold">
                    View <ArrowRight className="size-3.5" />
                </span>
            </div>
        </article>
    );
}

function DashboardMockup({ compact = false }: { compact?: boolean }) {
    return (
        <MockShell
            compact={compact}
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-700"
        >
            <div className="p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-muted-foreground text-xs font-medium">
                            Dashboard
                        </p>
                        <h2 className="text-foreground mt-2 text-xl font-semibold sm:text-2xl">
                            Welcome back, jakob
                        </h2>
                        <p className="text-muted-foreground mt-1 text-xs sm:text-sm">
                            Manage and monitor your Vinted scrapers.
                        </p>
                    </div>
                    <div className="hidden items-center gap-2 sm:flex">
                        <button className="h-8 rounded-md border border-red-500/25 px-3 text-xs font-semibold text-red-600 dark:text-red-400">
                            Stop all
                        </button>
                        <button className="bg-foreground text-background h-8 rounded-md px-3 text-xs font-semibold">
                            New monitor
                        </button>
                    </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <Metric label="Monitors" value="8" />
                    <Metric label="Active" value="5" />
                    <Metric label="Items found" value="7,022" />
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                    {monitors.map((monitor) => (
                        <MonitorCard key={monitor.name} monitor={monitor} />
                    ))}
                </div>
            </div>
        </MockShell>
    );
}

function MobileHeroMockup() {
    return (
        <div className="landing-card border-border bg-card/90 shadow-foreground/8 overflow-hidden rounded-lg border shadow-2xl">
            <div className="border-border bg-muted/35 flex items-center justify-between border-b px-3 py-2.5">
                <div className="flex items-center gap-2">
                    <LogoMark className="size-6" />
                    <div>
                        <p className="text-foreground text-xs font-semibold">
                            Vintrack
                        </p>
                        <p className="text-muted-foreground text-[10px]">
                            Mobile control
                        </p>
                    </div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
                    live
                </span>
            </div>

            <div className="p-3">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-muted-foreground text-[11px] font-medium">
                            Dashboard
                        </p>
                        <h2 className="text-foreground mt-1 text-lg font-semibold">
                            5 monitors active
                        </h2>
                    </div>
                    <button className="bg-foreground text-background h-8 rounded-md px-3 text-xs font-semibold">
                        New
                    </button>
                </div>

                <div className="mt-3 grid min-w-0 grid-cols-3 gap-2">
                    {[
                        ["Active", "5"],
                        ["Found", "7k"],
                        ["Delay", "1.5s"],
                    ].map(([label, value]) => (
                        <div
                            key={label}
                            className="border-border bg-background/70 min-w-0 rounded-md border px-2 py-2"
                        >
                            <p className="text-muted-foreground text-[9px] font-semibold tracking-[0.12em] uppercase">
                                {label}
                            </p>
                            <p className="text-foreground mt-1 text-base font-semibold">
                                {value}
                            </p>
                        </div>
                    ))}
                </div>

                <div className="mt-3 space-y-2">
                    {monitors.slice(0, 2).map((monitor) => (
                        <div
                            key={monitor.name}
                            className="border-border bg-background/70 min-w-0 overflow-hidden rounded-md border p-2.5"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="text-foreground truncate text-xs font-semibold">
                                        {monitor.name}
                                    </p>
                                    <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[10px]">
                                        <span>{monitor.region}</span>
                                        <span className="bg-muted-foreground/40 size-1 rounded-full" />
                                        <span>{monitor.delay}</span>
                                    </div>
                                </div>
                                <span className="hidden shrink-0 min-[360px]:inline-flex">
                                    <StatusBadge status={monitor.status} />
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function IllustrationFrame({
    children,
    className = "",
    minHeightClass = "min-h-[360px]",
}: {
    children: ReactNode;
    className?: string;
    minHeightClass?: string;
}) {
    return (
        <div
            className={`relative ${minHeightClass} border-border bg-card shadow-foreground/5 overflow-hidden rounded-lg border shadow-xl ${className}`}
        >
            <div className="bg-size[56px_56px] absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_oklab,var(--border)_46%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklab,var(--border)_46%,transparent)_1px,transparent_1px)] opacity-30" />
            <div className="from-background/70 absolute inset-x-0 top-0 h-32 bg-linear-to-b to-transparent" />
            <div className="relative h-full p-5 sm:p-6">{children}</div>
        </div>
    );
}

function MonitorSetupIllustration() {
    return (
        <IllustrationFrame className="h-full min-h-0">
            <div className="flex h-full flex-col gap-5">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.18em] uppercase">
                            Monitor builder
                        </p>
                        <h3 className="text-foreground mt-2 text-lg font-semibold">
                            Build a live monitor
                        </h3>
                    </div>
                    <SlidersHorizontal className="text-muted-foreground size-5" />
                </div>

                <div className="relative flex flex-1 items-center justify-center">
                    <div className="landing-line-pulse bg-border absolute inset-x-8 top-1/2 h-px" />
                    <div className="landing-line-pulse bg-border absolute top-8 left-1/2 h-48 w-px -translate-x-1/2" />
                    <div className="landing-scan pointer-events-none absolute inset-x-12 top-1/2 h-12 bg-linear-to-b from-transparent via-emerald-500/10 to-transparent" />
                    <div className="landing-float border-border bg-background shadow-foreground/10 relative z-10 w-full max-w-75 overflow-hidden rounded-lg border shadow-2xl">
                        <div className="border-border bg-card flex items-center justify-between border-b px-3.5 py-3">
                            <div className="flex items-center gap-2.5">
                                <div className="bg-foreground text-background flex size-7 items-center justify-center rounded-md">
                                    <PackageSearch className="size-4" />
                                </div>
                                <div>
                                    <p className="text-foreground text-sm font-semibold">
                                        Monitor draft
                                    </p>
                                </div>
                            </div>
                            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                ready
                            </span>
                        </div>

                        <div className="space-y-2.5 p-3.5">
                            <div className="border-border bg-card rounded-md border px-3 py-2.5">
                                <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.14em] uppercase">
                                    Search query
                                </p>
                                <div className="mt-2 flex items-center justify-between gap-3">
                                    <p className="text-foreground truncate text-base font-semibold">
                                        Nike Dunk Low
                                    </p>
                                    <span className="text-muted-foreground shrink-0 text-xs font-semibold">
                                        FR
                                    </span>
                                </div>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                <div className="border-border bg-card rounded-md border px-2.5 py-2">
                                    <div className="text-muted-foreground flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] uppercase">
                                        <Timer className="size-3" />
                                        Delay
                                    </div>
                                    <p className="text-foreground mt-1 text-sm font-semibold">
                                        1.5s
                                    </p>
                                </div>
                                <div className="border-border bg-card rounded-md border px-2.5 py-2">
                                    <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.14em] uppercase">
                                        Size
                                    </p>
                                    <p className="text-foreground mt-1 text-sm font-semibold">
                                        39 EU
                                    </p>
                                </div>
                                <div className="border-border bg-card rounded-md border px-2.5 py-2">
                                    <div className="text-muted-foreground flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] uppercase">
                                        <Webhook className="size-3" />
                                        Proxy
                                    </div>
                                    <p className="text-foreground mt-1 text-sm font-semibold">
                                        Resi
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                                <span className="flex items-center gap-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                    <span className="size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
                                    Ready to launch
                                </span>
                                <Radio className="size-4 text-emerald-600 dark:text-emerald-400" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </IllustrationFrame>
    );
}

function LiveSignalIllustration() {
    return (
        <IllustrationFrame className="h-full min-h-0">
            <div className="flex h-full flex-col gap-5">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.18em] uppercase">
                            Live detection
                        </p>
                        <h3 className="text-foreground mt-2 text-lg font-semibold">
                            Fresh items surface
                        </h3>
                    </div>
                    <Radio className="text-muted-foreground size-5" />
                </div>

                <div className="relative flex flex-1 items-center justify-center">
                    <div className="landing-line-pulse bg-border absolute inset-x-8 top-1/2 h-px" />
                    <div className="landing-line-pulse bg-border absolute top-8 left-1/2 h-52 w-px -translate-x-1/2" />
                    <div className="border-border bg-background/70 absolute top-7 left-7 w-36 rotate-[-4deg] rounded-lg border p-3 shadow-sm">
                        <div className="bg-muted h-2.5 w-20 rounded-full" />
                        <div className="bg-muted mt-3 h-2.5 w-14 rounded-full" />
                    </div>
                    <div className="border-border bg-background/70 absolute right-5 bottom-7 w-40 rotate-3 rounded-lg border p-3 shadow-sm">
                        <div className="flex items-center justify-between">
                            <span className="bg-muted h-2 w-16 rounded-full" />
                            <span className="size-2 rounded-full bg-emerald-500" />
                        </div>
                        <div className="bg-muted mt-3 h-2 w-28 rounded-full" />
                    </div>

                    {[0, 1, 2].map((index) => (
                        <div
                            key={index}
                            className={`absolute rounded-full ${
                                index === 0
                                    ? "bg-muted-foreground/30 top-[34%] left-[18%] size-2.5"
                                    : index === 1
                                      ? "bg-muted-foreground/30 top-[42%] right-[18%] size-2.5"
                                      : "bottom-[21%] left-[47%] size-3 bg-emerald-500"
                            }`}
                        />
                    ))}

                    <div className="landing-float-slow border-border bg-background shadow-foreground/10 relative z-10 w-52 overflow-hidden rounded-lg border shadow-2xl">
                        <div className="relative h-36 bg-sky-100 dark:bg-sky-950/50">
                            <div className="from-background/70 absolute inset-x-0 bottom-0 h-16 bg-linear-to-t to-transparent" />
                            <div className="border-foreground/10 bg-background/45 absolute top-7 left-8 size-16 rounded-full border" />
                            <div className="bg-background/85 shadow-foreground/5 absolute right-5 bottom-8 h-12 w-24 rotate-[-8deg] rounded-[44%] shadow-lg" />
                            <div className="bg-background/70 absolute bottom-10 left-13 h-8 w-20 rotate-[8deg] rounded-[44%]" />
                            <div className="absolute top-3 left-3 rounded-md bg-emerald-500 px-2.5 py-1.5 text-[10px] font-bold text-white">
                                NEW
                            </div>
                            <div className="bg-background text-foreground absolute bottom-4 left-3 rounded-md px-3 py-1.5 text-sm font-bold shadow-sm">
                                80.0 EUR
                            </div>
                        </div>
                        <div className="p-3.5">
                            <p className="text-foreground truncate text-sm font-semibold">
                                Nike Dunk Low Grey
                            </p>
                            <div className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
                                <span>19:56</span>
                                <span className="bg-muted-foreground/50 size-1 rounded-full" />
                                <span>France</span>
                                <span className="bg-muted-foreground/50 size-1 rounded-full" />
                                <span>size 39</span>
                            </div>
                        </div>
                    </div>

                    <div className="landing-float absolute top-9 right-0 z-20 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-600 shadow-sm dark:text-emerald-400">
                        + live signal
                    </div>
                </div>
            </div>
        </IllustrationFrame>
    );
}

function AlertFlowIllustration() {
    return (
        <IllustrationFrame className="h-full min-h-0">
            <div className="flex h-full flex-col gap-5">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.18em] uppercase">
                            Alert routing
                        </p>
                        <h3 className="text-foreground mt-2 text-lg font-semibold">
                            One match, all channels
                        </h3>
                    </div>
                    <Bell className="text-muted-foreground size-5" />
                </div>

                <div className="relative flex min-h-60 flex-1 items-center justify-center">
                    <div className="landing-line-pulse bg-border absolute top-1/2 right-8 left-8 h-px" />
                    <div className="landing-line-pulse bg-border absolute top-9 left-1/2 h-48 w-px -translate-x-1/2" />

                    <div className="landing-float border-border bg-background shadow-foreground/5 absolute top-2 left-0 w-48 rounded-lg border p-3 shadow-xl">
                        <div className="flex items-center gap-2">
                            <div className="bg-foreground text-background flex size-8 items-center justify-center rounded-md">
                                <Bell className="size-4" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-foreground truncate text-sm font-semibold">
                                    Discord alert
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    #finds
                                </p>
                            </div>
                        </div>
                        <div className="bg-muted/50 mt-3 rounded-md border-l-2 border-emerald-500 p-3">
                            <p className="text-foreground truncate text-sm font-semibold">
                                Ralph Lauren shirt
                            </p>
                            <p className="text-muted-foreground mt-1 text-xs">
                                18 EUR · XL · DE
                            </p>
                        </div>
                    </div>

                    <div className="landing-float-slow border-border bg-background shadow-foreground/5 absolute top-28 right-0 w-44 rounded-lg border p-3 shadow-xl">
                        <div className="flex items-center justify-between">
                            <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
                                <MessageCircle className="text-muted-foreground size-4" />
                                Telegram
                            </span>
                            <CheckCircle2 className="size-4 text-emerald-500" />
                        </div>
                        <p className="text-muted-foreground mt-3 text-xs leading-5">
                            New match from Polo Ralph Lauren.
                        </p>
                    </div>

                    <div className="shadow-foreground/5 landing-float absolute right-2 bottom-2 left-10 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 shadow-xl">
                        <div className="flex items-center justify-between gap-3">
                            <span className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                                <LayoutDashboard className="size-4" />
                                Dashboard feed
                            </span>
                            <span className="bg-background text-foreground rounded-md px-2 py-1 text-[10px] font-semibold">
                                synced
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </IllustrationFrame>
    );
}

function AccountActionIllustration() {
    const actions = [
        { label: "Like", icon: Heart },
        { label: "Message", icon: MessageCircle },
        { label: "Offer", icon: Send },
        { label: "Checkout", icon: ShoppingCart },
    ];

    return (
        <IllustrationFrame>
            <div className="flex h-full flex-col justify-between gap-6">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.18em] uppercase">
                            Linked account
                        </p>
                        <h3 className="text-foreground mt-2 text-lg font-semibold">
                            Actions stay attached
                        </h3>
                    </div>
                    <ShieldCheck className="text-muted-foreground size-5" />
                </div>

                <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-4">
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="flex size-11 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                                <ShieldCheck className="size-5" />
                            </div>
                            <div>
                                <p className="text-foreground text-sm font-semibold">
                                    @vintrack_account
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Linked to www.vinted.de
                                </p>
                            </div>
                        </div>
                        <span className="bg-background text-foreground rounded-full px-3 py-1 text-xs font-semibold">
                            active
                        </span>
                    </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    {actions.map((action) => (
                        <div
                            key={action.label}
                            className="border-border bg-background/80 flex items-center justify-between rounded-md border p-3"
                        >
                            <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
                                <action.icon className="text-muted-foreground size-4" />
                                {action.label}
                            </span>
                            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-semibold">
                                Ready
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </IllustrationFrame>
    );
}

function FreeProxyPoolIllustration() {
    const regions = [
        { code: "DE", label: "Germany", status: "Ready", tone: "ready" },
        { code: "FR", label: "France", status: "Ready", tone: "ready" },
        { code: "NL", label: "Netherlands", status: "Ready", tone: "ready" },
        {
            code: "UK",
            label: "United Kingdom",
            status: "Checking",
            tone: "checking",
        },
        { code: "PL", label: "Poland", status: "Checking", tone: "checking" },
    ];
    const validationStages: {
        icon: LucideIcon;
        title: string;
        detail: string;
    }[] = [
        { icon: Server, title: "Import", detail: "Candidates" },
        { icon: RefreshCw, title: "Validate", detail: "Against Vinted" },
        { icon: ShieldCheck, title: "Rotate", detail: "Healthy only" },
    ];

    return (
        <IllustrationFrame minHeightClass="min-h-[430px]">
            <div className="flex h-full flex-col gap-5">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold uppercase">
                            Shared infrastructure
                        </p>
                        <h3 className="mt-2 text-lg font-semibold">
                            Free Proxy Pool
                        </h3>
                    </div>
                    <span className="border-border bg-background flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[10px] font-semibold uppercase">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        Health managed
                    </span>
                </div>

                <div className="border-border bg-background/75 overflow-hidden rounded-lg border">
                    <div className="border-border bg-muted/30 grid grid-cols-[1fr_auto] border-b px-4 py-3 text-[10px] font-semibold uppercase">
                        <span className="text-muted-foreground">
                            Region pool
                        </span>
                        <span className="text-muted-foreground">Status</span>
                    </div>
                    <div className="divide-border/60 divide-y">
                        {regions.map((region) => (
                            <div
                                key={region.code}
                                className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5"
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <span className="border-border bg-muted/40 flex h-7 w-9 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold">
                                        {region.code}
                                    </span>
                                    <span className="truncate text-xs font-medium">
                                        {region.label}
                                    </span>
                                </div>
                                <span
                                    className={`flex items-center gap-1.5 text-[10px] font-semibold ${
                                        region.tone === "ready"
                                            ? "text-emerald-600 dark:text-emerald-400"
                                            : "text-amber-600 dark:text-amber-400"
                                    }`}
                                >
                                    <span
                                        className={`size-1.5 rounded-full ${
                                            region.tone === "ready"
                                                ? "bg-emerald-500"
                                                : "bg-amber-500"
                                        }`}
                                    />
                                    {region.status}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="mt-auto grid grid-cols-3 gap-2">
                    {validationStages.map((stage) => {
                        const StepIcon = stage.icon;
                        return (
                            <div
                                key={stage.title}
                                className="border-border bg-background/70 min-w-0 rounded-md border p-3"
                            >
                                <StepIcon className="text-muted-foreground size-4" />
                                <p className="mt-2 truncate text-xs font-semibold">
                                    {stage.title}
                                </p>
                                <p className="text-muted-foreground mt-0.5 truncate text-[10px]">
                                    {stage.detail}
                                </p>
                            </div>
                        );
                    })}
                </div>
                <p className="text-muted-foreground text-[10px] leading-4">
                    Example health view. Live availability changes as proxies
                    pass or fail regional checks.
                </p>
            </div>
        </IllustrationFrame>
    );
}

function ProductSystemCard({
    icon: Icon,
    kicker,
    title,
    copy,
    children,
}: {
    icon: LucideIcon;
    kicker: string;
    title: string;
    copy: string;
    children: ReactNode;
}) {
    return (
        <article className="landing-card border-border bg-card/50 flex h-136 flex-col overflow-hidden rounded-lg border">
            <div className="border-border bg-background/35 h-90 min-h-0 shrink-0 overflow-hidden border-b">
                {children}
            </div>
            <div className="bg-card/60 flex h-46 min-h-0 shrink-0 flex-col p-5">
                <div className="flex items-start gap-3">
                    <span className="border-border bg-background text-foreground flex size-9 shrink-0 items-center justify-center rounded-md border">
                        <Icon className="size-4" />
                    </span>
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.18em] uppercase">
                            {kicker}
                        </p>
                        <h3 className="mt-1.5 text-xl font-semibold">
                            {title}
                        </h3>
                    </div>
                </div>
                <p className="text-muted-foreground mt-3 text-sm leading-6">
                    {copy}
                </p>
            </div>
        </article>
    );
}

export default async function Home() {
    const session = await auth();

    if (session?.user) {
        redirect("/dashboard");
    }

    const websiteJsonLd = {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Vintrack",
        url: absoluteMarketingUrl("/"),
    };

    return (
        <main className="overflow-x-hidden">
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{
                    __html: JSON.stringify(websiteJsonLd).replace(
                        /</g,
                        "\\u003c",
                    ),
                }}
            />

            <section className="border-border relative isolate overflow-hidden border-b">
                <div className="landing-grid pointer-events-none absolute inset-0 -z-20 opacity-45" />
                <div className="pointer-events-none absolute top-24 right-[max(2rem,calc((100vw-80rem)/2))] -z-10 hidden w-[min(820px,58vw)] md:block">
                    <DashboardMockup compact />
                </div>
                <div className="from-background via-background/95 absolute inset-x-0 bottom-0 -z-10 h-48 bg-linear-to-t to-transparent" />
                <div className="from-background via-background/95 to-background/10 absolute inset-y-0 left-0 -z-10 w-[72%] bg-linear-to-r dark:w-[68%]" />

                <div className="mx-auto flex min-h-170 max-w-7xl items-start px-4 py-10 sm:px-6 sm:py-24 lg:px-8">
                    <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 w-full max-w-md motion-safe:duration-700">
                        <div className="border-border bg-background/80 text-foreground mb-5 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur">
                            <Globe2 className="size-3.5 text-emerald-600" />
                            Free proxy pools in available regions
                        </div>
                        <h1 className="text-foreground text-5xl leading-[0.98] font-semibold tracking-tight sm:text-7xl">
                            The open-source Vinted monitor for faster finds.
                        </h1>
                        <p className="text-muted-foreground mt-6 max-w-md text-base leading-8 sm:text-lg">
                            Create precise searches, watch fresh listings in a
                            live dashboard, and route matches to Discord or
                            Telegram. Try the hosted demo or run the complete
                            stack yourself.
                        </p>
                        <div className="mt-7 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                            <Button asChild size="lg">
                                <Link href="/login">
                                    Start monitoring
                                    <ArrowRight />
                                </Link>
                            </Button>
                            <Button asChild variant="outline" size="lg">
                                <a
                                    href="https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    Self-host Vintrack
                                    <Github />
                                </a>
                            </Button>
                        </div>
                        <div className="text-muted-foreground mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                            <span className="flex items-center gap-1.5">
                                <CheckCircle2 className="size-3.5 text-emerald-600" />
                                No proxy purchase for ready regions
                            </span>
                            <span className="flex items-center gap-1.5">
                                <ShieldCheck className="size-3.5 text-sky-600" />
                                Bring your own proxies anytime
                            </span>
                        </div>
                        <a
                            href="https://discord.gg/WbEpEjaWjP"
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground mt-5 inline-flex items-center gap-2 text-xs font-medium transition-colors"
                        >
                            <MessageCircle className="size-3.5" />
                            Questions? Join the Vintrack Discord
                        </a>
                        <div className="mt-8 md:hidden">
                            <MobileHeroMockup />
                        </div>
                    </div>
                </div>
            </section>

            <section
                id="free-proxies"
                className="border-border bg-muted/18 scroll-mt-16 border-b px-4 py-20 sm:px-6 lg:px-8"
            >
                <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
                    <div className="landing-reveal">
                        <SectionHeader
                            kicker="Free starter access"
                            title="Run your first monitor before buying proxies."
                            copy="Vintrack imports public proxy candidates, validates them directly against each Vinted region, and rotates only healthy proxies into the shared starter pool."
                        />
                        <div className="mt-7 space-y-3">
                            {[
                                "Ready regions appear directly in the monitor proxy selector.",
                                "Failing proxies move to cooldown or leave rotation automatically.",
                                "Free pools handle catalog monitoring only; account actions stay isolated.",
                            ].map((benefit) => (
                                <div
                                    key={benefit}
                                    className="flex items-start gap-3 text-sm"
                                >
                                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                                    <span className="text-muted-foreground leading-6">
                                        {benefit}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="mt-7 flex flex-wrap gap-2">
                            <Button asChild>
                                <Link href="/login">
                                    Start with the Free Pool
                                    <ArrowRight />
                                </Link>
                            </Button>
                            <Button asChild variant="outline">
                                <Link href="#workflow">See how it works</Link>
                            </Button>
                        </div>
                        <p className="text-muted-foreground mt-4 text-xs leading-5">
                            Shared free proxies are best-effort infrastructure.
                            Availability and speed vary by region and current
                            pool health.
                        </p>
                    </div>
                    <div className="landing-reveal">
                        <FreeProxyPoolIllustration />
                    </div>
                </div>
            </section>

            <section className="border-border border-b px-4 py-16 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
                    <div className="landing-reveal">
                        <SectionHeader
                            kicker="Built for the workflow"
                            title="Less noise between a fresh listing and the next move."
                            copy="Vintrack keeps setup, monitoring, alerting, and Vinted actions in a single interface instead of spreading them across scripts and chat messages."
                        />
                    </div>
                    <div className="landing-reveal grid gap-4 sm:grid-cols-2">
                        {features.map((feature) => (
                            <article
                                key={feature.title}
                                className="border-border hover:bg-card/70 rounded-lg border-t p-5 transition-colors sm:border"
                            >
                                <feature.icon className="text-foreground mb-4 size-5" />
                                <h3 className="text-foreground text-sm font-semibold">
                                    {feature.title}
                                </h3>
                                <p className="text-muted-foreground mt-2 text-sm leading-6">
                                    {feature.copy}
                                </p>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section
                id="product"
                className="border-border bg-muted/18 border-b px-4 py-20 sm:px-6 lg:px-8"
            >
                <div className="mx-auto flex max-w-6xl flex-col gap-10">
                    <div className="landing-reveal">
                        <SectionHeader
                            kicker="Product"
                            title="Three systems behind every find."
                            copy="The product is easier to understand when each feature has one visual job: configure, detect, and route."
                        />
                    </div>

                    <div className="landing-reveal grid auto-rows-fr gap-5 lg:grid-cols-3 lg:items-stretch">
                        <ProductSystemCard
                            icon={SlidersHorizontal}
                            kicker="Monitor setup"
                            title="Exact search intent."
                            copy="Keywords, region, query delay, proxy source, and filters turn into one running monitor."
                        >
                            <MonitorSetupIllustration />
                        </ProductSystemCard>
                        <ProductSystemCard
                            icon={Radio}
                            kicker="Live feed"
                            title="Fresh finds surface first."
                            copy="New listings move through a readable stream with price, context, timing, and monitor source."
                        >
                            <LiveSignalIllustration />
                        </ProductSystemCard>
                        <ProductSystemCard
                            icon={Bell}
                            kicker="Alerts"
                            title="One match routes everywhere."
                            copy="Discord, Telegram, and the dashboard receive the same clean match payload."
                        >
                            <AlertFlowIllustration />
                        </ProductSystemCard>
                    </div>
                </div>
            </section>

            <section
                id="workflow"
                className="border-border border-b px-4 py-20 sm:px-6 lg:px-8"
            >
                <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
                    <div className="landing-reveal">
                        <SectionHeader
                            kicker="Workflow"
                            title="Set it up once, then work from the feed."
                            copy="The critical path is short: configure search intent, watch live results, then act immediately from the dashboard or alert."
                        />
                        <div className="mt-8 space-y-5">
                            {workflow.map((step, index) => (
                                <div key={step.title} className="flex gap-4">
                                    <span className="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-bold">
                                        {index + 1}
                                    </span>
                                    <div>
                                        <h3 className="text-foreground text-sm font-semibold">
                                            {step.title}
                                        </h3>
                                        <p className="text-muted-foreground mt-1 text-sm leading-6">
                                            {step.copy}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="landing-reveal grid gap-5 sm:grid-cols-2">
                        <MonitorSetupIllustration />
                        <LiveSignalIllustration />
                    </div>
                </div>
            </section>

            <section
                id="actions"
                className="border-border border-b px-4 py-20 sm:px-6 lg:px-8"
            >
                <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                    <div className="landing-reveal">
                        <AccountActionIllustration />
                    </div>

                    <div className="landing-reveal">
                        <SectionHeader
                            kicker="Linked account"
                            title="Buying actions stay attached to the find."
                            copy="When an item is worth moving on, the dashboard can like it, message the seller, send an offer, or start checkout without making the operator hunt for context."
                        />
                    </div>
                </div>
            </section>

            <section className="border-border bg-muted/18 border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-6xl">
                    <SectionHeader
                        kicker="Choose your workflow"
                        title="One monitor, three focused ways to use it."
                        copy="Explore the Vintrack capability that matches what you need now, without losing the option to move between the hosted demo and your own infrastructure."
                    />
                    <div className="mt-10 grid gap-5 md:grid-cols-3">
                        {[
                            {
                                icon: Bell,
                                title: "New-listing alerts",
                                copy: "Send filtered finds to Discord, Telegram, and the live dashboard.",
                                href: "/vinted-alerts",
                            },
                            {
                                icon: Timer,
                                title: "Price drop tracking",
                                copy: "Watch individual Vinted items and get notified when their price changes.",
                                href: "/vinted-price-tracker",
                            },
                            {
                                icon: Github,
                                title: "Self-hosted control",
                                copy: "Run the open-source Docker stack with your own data and proxy setup.",
                                href: "/self-hosted-vinted-monitor",
                            },
                        ].map((useCase) => (
                            <Link
                                key={useCase.href}
                                href={useCase.href}
                                className="border-border bg-card hover:border-foreground/25 group rounded-lg border p-6 transition-colors"
                            >
                                <useCase.icon className="size-5" />
                                <h3 className="mt-5 text-lg font-semibold">
                                    {useCase.title}
                                </h3>
                                <p className="text-muted-foreground mt-3 text-sm leading-6">
                                    {useCase.copy}
                                </p>
                                <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold">
                                    Explore
                                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                                </span>
                            </Link>
                        ))}
                    </div>
                </div>
            </section>

            <MarketingCta
                title="Start with one monitor."
                copy="Sign in to the hosted demo or inspect the full open-source stack before choosing where Vintrack should run."
                primary={{ label: "Start monitoring", href: "/login" }}
                secondary={{
                    label: "Self-host Vintrack",
                    href: "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor",
                }}
            />
        </main>
    );
}
