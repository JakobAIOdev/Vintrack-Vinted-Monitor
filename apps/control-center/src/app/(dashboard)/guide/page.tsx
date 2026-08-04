import { Button } from "@/components/ui/button";
import {
    Bell,
    Check,
    CheckCircle2,
    Chrome,
    CircleGauge,
    Download,
    ExternalLink,
    Globe2,
    Heart,
    Link as LinkIcon,
    ListFilter,
    MessageCircle,
    MonitorDot,
    Send,
    ShieldCheck,
    ShoppingCart,
    Tag,
    UserRound,
} from "lucide-react";
import Link from "next/link";

const CHROME_EXTENSION_DOWNLOAD_URL =
    "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension.zip";
const FIREFOX_EXTENSION_DOWNLOAD_URL =
    "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension-firefox.xpi";

const STEPS = [
    {
        number: "01",
        title: "Choose a proxy source",
        detail: "Use a ready Free Pool region or add your own proxy group.",
        href: "#proxies",
        icon: Globe2,
    },
    {
        number: "02",
        title: "Create the monitor",
        detail: "Set the query, region, filters, alerts, and proxy source.",
        href: "#monitors",
        icon: MonitorDot,
    },
    {
        number: "03",
        title: "Connect alerts",
        detail: "Add Discord, Telegram, or both notification channels.",
        href: "#alerts",
        icon: Bell,
    },
    {
        number: "04",
        title: "Link your account",
        detail: "Enable likes, messages, offers, and browser checkout.",
        href: "#account",
        icon: UserRound,
    },
];

const MONITOR_SECTIONS = [
    {
        title: "Basics",
        detail: "Name, search query, Vinted region, and polling delay.",
        icon: MonitorDot,
    },
    {
        title: "Filters",
        detail: "Price, brand, size, condition, color, and seller countries.",
        icon: ListFilter,
    },
    {
        title: "Notifications",
        detail: "Discord webhook and Telegram delivery settings.",
        icon: Bell,
    },
    {
        title: "Proxy Source",
        detail: "Free Pool, shared server proxies, or a personal group.",
        icon: ShieldCheck,
    },
];

const ITEM_ACTIONS = [
    { label: "Like", icon: Heart, className: "text-rose-500" },
    { label: "Checkout", icon: ShoppingCart, className: "text-amber-500" },
    { label: "Offer", icon: Tag, className: "text-emerald-500" },
    { label: "Message", icon: MessageCircle, className: "text-sky-500" },
];

function StepList({ steps }: { steps: string[] }) {
    return (
        <ol className="mt-4 space-y-3">
            {steps.map((step, index) => (
                <li
                    key={step}
                    className="grid grid-cols-[32px_1fr] items-start gap-4 text-sm"
                >
                    <span className="border-border bg-muted/40 flex h-8 w-8 items-center justify-center rounded-md border text-xs font-semibold tabular-nums">
                        {index + 1}
                    </span>
                    <span className="text-muted-foreground pt-1 leading-6">
                        {step}
                    </span>
                </li>
            ))}
        </ol>
    );
}

function SectionHeading({
    number,
    title,
    description,
}: {
    number: string;
    title: string;
    description: string;
}) {
    return (
        <div className="lg:sticky lg:top-8 lg:self-start">
            <p className="text-muted-foreground text-[11px] font-semibold uppercase">
                Step {number}
            </p>
            <h2 className="mt-3 text-2xl font-semibold">{title}</h2>
            <p className="text-muted-foreground mt-3 max-w-sm text-sm leading-7">
                {description}
            </p>
        </div>
    );
}

export default function GuidePage() {
    return (
        <div className="mx-auto max-w-6xl space-y-12">
            <header className="border-border/60 flex flex-col gap-6 border-b pb-8 md:flex-row md:items-end md:justify-between">
                <div>
                    <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase">
                        <CircleGauge className="h-4 w-4" />
                        Vintrack workflow
                    </div>
                    <h1 className="mt-4 text-3xl font-bold">Setup Guide</h1>
                    <p className="text-muted-foreground mt-3 max-w-2xl text-sm leading-7">
                        Go from a new account to a running monitor with clean
                        alerts and optional Vinted account actions.
                    </p>
                </div>
                <Button asChild className="self-start md:self-auto">
                    <Link href="/monitors/new">
                        <MonitorDot className="h-4 w-4" />
                        Create monitor
                    </Link>
                </Button>
            </header>

            <nav
                aria-label="Guide sections"
                className="border-border/60 bg-border/60 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-4"
            >
                {STEPS.map((step) => {
                    const Icon = step.icon;
                    return (
                        <a
                            key={step.number}
                            href={step.href}
                            className="bg-card hover:bg-muted/35 group min-w-0 p-5 transition-colors"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <span className="text-muted-foreground text-[11px] font-semibold tabular-nums">
                                    {step.number}
                                </span>
                                <Icon className="text-muted-foreground group-hover:text-foreground h-4 w-4 transition-colors" />
                            </div>
                            <p className="mt-4 text-sm font-semibold">
                                {step.title}
                            </p>
                            <p className="text-muted-foreground mt-2 text-sm leading-6">
                                {step.detail}
                            </p>
                        </a>
                    );
                })}
            </nav>

            <main className="divide-border/60 divide-y">
                <section
                    id="proxies"
                    className="scroll-mt-8 py-16 first:pt-4 lg:grid lg:grid-cols-[240px_1fr] lg:gap-16"
                >
                    <SectionHeading
                        number="01"
                        title="Proxy source"
                        description="Every monitor needs a stable route to its selected Vinted region. Start free, then move to a personal group when you need dedicated capacity."
                    />
                    <div className="mt-8 space-y-8 lg:mt-0">
                        <div className="grid gap-5 md:grid-cols-2">
                            <div className="border-border/60 rounded-lg border p-5 sm:p-6">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-2">
                                        <Globe2 className="h-4 w-4 text-emerald-600" />
                                        <h3 className="text-sm font-semibold">
                                            Free Proxy Pool
                                        </h3>
                                    </div>
                                    <span className="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-700 uppercase dark:text-emerald-300">
                                        Start here
                                    </span>
                                </div>
                                <p className="text-muted-foreground mt-4 text-sm leading-6">
                                    Available without buying proxies. In the
                                    monitor form, choose a region marked Ready.
                                    Regions marked Checking are visible but stay
                                    out of rotation until enough proxies pass
                                    validation.
                                </p>
                            </div>
                            <div className="border-border/60 rounded-lg border p-5 sm:p-6">
                                <div className="flex items-center gap-2">
                                    <ShieldCheck className="h-4 w-4 text-sky-600" />
                                    <h3 className="text-sm font-semibold">
                                        Personal Proxy Group
                                    </h3>
                                </div>
                                <p className="text-muted-foreground mt-4 text-sm leading-6">
                                    Dedicated proxies give you predictable
                                    capacity. Add one proxy per line using URL,
                                    host:port, or authenticated formats. This is
                                    the better option for sustained use or many
                                    monitors.
                                </p>
                                <code className="bg-muted/50 mt-4 block rounded-md px-3 py-2.5 text-xs">
                                    host:port:user:password
                                </code>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button asChild variant="outline" size="sm">
                                <Link href="/proxies">
                                    <Globe2 className="h-4 w-4" />
                                    Open proxy overview
                                </Link>
                            </Button>
                            <span className="text-muted-foreground flex items-center gap-2 px-2 text-sm">
                                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                Live region health is visible here and in the
                                monitor form.
                            </span>
                        </div>
                        <p className="text-muted-foreground max-w-3xl text-sm leading-7">
                            The Free Pool is shared, best-effort infrastructure
                            for catalog monitoring. Availability can change as
                            public proxies pass or fail validation. Linked
                            account actions never use this pool.
                        </p>
                    </div>
                </section>

                <section
                    id="monitors"
                    className="scroll-mt-8 py-16 lg:grid lg:grid-cols-[240px_1fr] lg:gap-16"
                >
                    <SectionHeading
                        number="02"
                        title="Build the monitor"
                        description="Start with a precise query and region. Open the collapsible sections only when you need more control."
                    />
                    <div className="mt-8 space-y-8 lg:mt-0">
                        <div className="border-border/60 overflow-hidden rounded-lg border">
                            {MONITOR_SECTIONS.map((section, index) => {
                                const Icon = section.icon;
                                return (
                                    <div
                                        key={section.title}
                                        className="border-border/60 flex items-start gap-4 border-b px-5 py-4 last:border-b-0"
                                    >
                                        <div className="bg-muted/50 flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
                                            <Icon className="text-muted-foreground h-4 w-4" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center justify-between gap-3">
                                                <p className="text-sm font-medium">
                                                    {section.title}
                                                </p>
                                                <span className="text-muted-foreground text-[10px] tabular-nums">
                                                    0{index + 1}
                                                </span>
                                            </div>
                                            <p className="text-muted-foreground mt-1 text-sm leading-6">
                                                {section.detail}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="grid gap-8 md:grid-cols-2">
                            <div>
                                <h3 className="text-sm font-semibold">
                                    Recommended first monitor
                                </h3>
                                <StepList
                                    steps={[
                                        "Use a specific query such as Nike Dunk Low, or separate alternative searches with commas.",
                                        "Choose the Vinted region where you want to receive listings.",
                                        "Add only filters that materially improve the results.",
                                        "Select a Ready Free Pool region or your own proxy group.",
                                    ]}
                                />
                            </div>
                            <div className="border-border/60 bg-muted/20 rounded-lg border p-5 sm:p-6">
                                <p className="text-sm font-semibold">
                                    Cleaner searches win
                                </p>
                                <p className="text-muted-foreground mt-3 text-sm leading-6">
                                    Use anti-keywords for recurring unwanted
                                    results. Comma-separated searches are
                                    rotated at the configured polling rate. Keep
                                    each query readable and let category, brand,
                                    size, and condition filters do the precise
                                    work.
                                </p>
                                <Button asChild size="sm" className="mt-5">
                                    <Link href="/monitors/new">
                                        Create monitor
                                    </Link>
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>

                <section
                    id="alerts"
                    className="scroll-mt-8 py-16 lg:grid lg:grid-cols-[240px_1fr] lg:gap-16"
                >
                    <SectionHeading
                        number="03"
                        title="Notifications"
                        description="Discord and Telegram receive the same match data. Use both when you want a channel archive and fast mobile delivery."
                    />
                    <div className="mt-8 space-y-8 lg:mt-0">
                        <div className="grid gap-10 md:grid-cols-2">
                            <div>
                                <div className="flex items-center gap-2">
                                    <Send className="h-4 w-4 text-sky-600" />
                                    <h3 className="text-sm font-semibold">
                                        Discord webhook
                                    </h3>
                                </div>
                                <StepList
                                    steps={[
                                        "Open Discord Channel Settings, then Integrations and Webhooks.",
                                        "Create a webhook and copy its URL.",
                                        "Paste it into the monitor's Notifications section.",
                                        "Choose Rich or Compact in Dashboard settings.",
                                        "Use Test before saving to verify delivery.",
                                    ]}
                                />
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <MessageCircle className="h-4 w-4 text-emerald-600" />
                                    <h3 className="text-sm font-semibold">
                                        Telegram
                                    </h3>
                                </div>
                                <StepList
                                    steps={[
                                        "Open the monitor's Notifications section.",
                                        "Generate a Telegram connection code.",
                                        "Send the code to the Vintrack bot.",
                                        "Enable Telegram and save the monitor.",
                                        "Choose Rich or Compact in Dashboard settings.",
                                    ]}
                                />
                            </div>
                        </div>
                        <div className="border-border/60 rounded-lg border p-5 sm:p-6">
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <p className="text-sm font-semibold">
                                        Match cards keep actions close
                                    </p>
                                    <p className="text-muted-foreground mt-2 text-sm leading-6">
                                        Open the listing, inspect the seller, or
                                        act through a linked account.
                                    </p>
                                </div>
                                <div className="flex gap-1">
                                    {ITEM_ACTIONS.map((action) => {
                                        const Icon = action.icon;
                                        return (
                                            <div
                                                key={action.label}
                                                className="border-border/60 flex h-9 items-center gap-2 rounded-md border px-2.5"
                                                title={action.label}
                                            >
                                                <Icon
                                                    className={`h-4 w-4 ${action.className}`}
                                                />
                                                <span className="hidden text-xs font-medium lg:inline">
                                                    {action.label}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section
                    id="account"
                    className="scroll-mt-8 py-16 lg:grid lg:grid-cols-[240px_1fr] lg:gap-16"
                >
                    <SectionHeading
                        number="04"
                        title="Account actions"
                        description="The browser extension links your existing Vinted session so Vintrack can perform user actions without asking for raw credentials."
                    />
                    <div className="mt-8 space-y-8 lg:mt-0">
                        <div className="grid gap-8 md:grid-cols-[1fr_300px]">
                            <div>
                                <h3 className="text-sm font-semibold">
                                    Connect the browser session
                                </h3>
                                <StepList
                                    steps={[
                                        "Install the Chrome or Firefox extension.",
                                        "Sign in to Vinted in the same browser.",
                                        "Open Account and choose Link With Installed Extension.",
                                        "Confirm the linked domain before using item actions.",
                                    ]}
                                />
                            </div>
                            <div className="border-border/60 bg-muted/20 rounded-lg border p-5 sm:p-6">
                                <ShieldCheck className="h-5 w-5 text-emerald-600" />
                                <p className="mt-3 text-sm font-semibold">
                                    Session-based connection
                                </p>
                                <p className="text-muted-foreground mt-3 text-sm leading-6">
                                    Vintrack syncs the session data, Vinted
                                    domain, browser user agent, and theme needed
                                    for linked actions. It does not require your
                                    Vinted password.
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button asChild variant="outline" size="sm">
                                <a
                                    href={CHROME_EXTENSION_DOWNLOAD_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <Chrome className="h-4 w-4" />
                                    Chrome extension
                                    <Download className="h-3.5 w-3.5" />
                                </a>
                            </Button>
                            <Button asChild variant="outline" size="sm">
                                <a
                                    href={FIREFOX_EXTENSION_DOWNLOAD_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    Firefox extension
                                    <Download className="h-3.5 w-3.5" />
                                </a>
                            </Button>
                            <Button asChild size="sm">
                                <Link href="/account">
                                    <LinkIcon className="h-4 w-4" />
                                    Connect account
                                </Link>
                            </Button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-border/60 flex flex-col gap-6 border-t py-10 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                    <div className="bg-muted/50 flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
                        <Check className="text-muted-foreground h-4 w-4" />
                    </div>
                    <div>
                        <p className="text-sm font-semibold">Setup complete?</p>
                        <p className="text-muted-foreground mt-1 text-sm leading-6">
                            Your monitor should now appear as Running and begin
                            filling the Live Feed.
                        </p>
                    </div>
                </div>
                <Button asChild variant="outline" size="sm">
                    <a
                        href="https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        GitHub support
                        <ExternalLink className="h-4 w-4" />
                    </a>
                </Button>
            </footer>
        </div>
    );
}
