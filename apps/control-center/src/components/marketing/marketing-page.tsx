import { Button } from "@/components/ui/button";
import { absoluteMarketingUrl } from "@/lib/seo";
import {
    ArrowRight,
    Bell,
    CheckCircle2,
    Database,
    Globe2,
    LayoutDashboard,
    MessageCircle,
    Radio,
    Send,
    Server,
    Timer,
} from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

function ActionLink({
    href,
    children,
    ...props
}: { href: string; children: ReactNode } & Omit<ComponentProps<"a">, "href">) {
    if (href.startsWith("http")) {
        return (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
                {children}
            </a>
        );
    }

    return (
        <Link href={href} {...props}>
            {children}
        </Link>
    );
}

export function MarketingPageHero({
    kicker,
    title,
    copy,
    primary,
    secondary,
    note,
    visual,
}: {
    kicker: string;
    title: string;
    copy: string;
    primary: { label: string; href: string };
    secondary: { label: string; href: string };
    note: string;
    visual: ReactNode;
}) {
    return (
        <section className="border-border relative isolate overflow-hidden border-b">
            <div className="landing-grid pointer-events-none absolute inset-0 -z-20 opacity-45" />
            <div className="from-background via-background/92 absolute inset-x-0 bottom-0 -z-10 h-40 bg-linear-to-t to-transparent" />
            <div className="mx-auto grid min-h-155 max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[0.92fr_1.08fr] lg:px-8">
                <div className="max-w-xl">
                    <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.2em] uppercase">
                        {kicker}
                    </p>
                    <h1 className="text-foreground mt-5 text-5xl leading-[0.98] font-semibold tracking-tight sm:text-6xl">
                        {title}
                    </h1>
                    <p className="text-muted-foreground mt-6 text-base leading-8 sm:text-lg">
                        {copy}
                    </p>
                    <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                        <Button asChild size="lg">
                            <ActionLink href={primary.href}>
                                {primary.label}
                                <ArrowRight />
                            </ActionLink>
                        </Button>
                        <Button asChild size="lg" variant="outline">
                            <ActionLink href={secondary.href}>
                                {secondary.label}
                            </ActionLink>
                        </Button>
                    </div>
                    <p className="text-muted-foreground mt-5 flex items-start gap-2 text-xs leading-5">
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                        {note}
                    </p>
                </div>
                <div>{visual}</div>
            </div>
        </section>
    );
}

export function MarketingSectionHeading({
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
            <h2 className="mt-3 text-3xl leading-tight font-semibold sm:text-4xl">
                {title}
            </h2>
            <p className="text-muted-foreground mt-4 text-sm leading-7 sm:text-base">
                {copy}
            </p>
        </div>
    );
}

export function FaqSection({
    items,
}: {
    items: Array<{ question: string; answer: string }>;
}) {
    return (
        <section className="border-border border-t px-4 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.65fr_1.35fr]">
                <MarketingSectionHeading
                    kicker="FAQ"
                    title="Straight answers before you start."
                    copy="Vintrack keeps monitoring, notifications, and account actions separate so you can enable only what you need."
                />
                <div className="divide-border border-border divide-y border-y">
                    {items.map((item) => (
                        <article key={item.question} className="py-6">
                            <h3 className="text-base font-semibold">
                                {item.question}
                            </h3>
                            <p className="text-muted-foreground mt-3 text-sm leading-7">
                                {item.answer}
                            </p>
                        </article>
                    ))}
                </div>
            </div>
        </section>
    );
}

export function BreadcrumbJsonLd({
    name,
    path,
}: {
    name: string;
    path:
        | "/vinted-alerts"
        | "/vinted-price-tracker"
        | "/self-hosted-vinted-monitor";
}) {
    const jsonLd = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
            {
                "@type": "ListItem",
                position: 1,
                name: "Vintrack",
                item: absoluteMarketingUrl("/"),
            },
            {
                "@type": "ListItem",
                position: 2,
                name,
                item: absoluteMarketingUrl(path),
            },
        ],
    };

    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
                __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
            }}
        />
    );
}

function PreviewShell({
    title,
    status,
    children,
}: {
    title: string;
    status: string;
    children: ReactNode;
}) {
    return (
        <div className="border-border bg-card shadow-foreground/5 overflow-hidden rounded-xl border shadow-2xl">
            <div className="border-border bg-muted/40 flex h-12 items-center justify-between border-b px-4">
                <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-rose-400" />
                    <span className="size-2 rounded-full bg-amber-400" />
                    <span className="size-2 rounded-full bg-emerald-400" />
                    <span className="ml-2 text-xs font-semibold">{title}</span>
                </div>
                <span className="border-border bg-background text-muted-foreground rounded-md border px-2 py-1 text-[10px] font-semibold">
                    {status}
                </span>
            </div>
            {children}
        </div>
    );
}

export function AlertPreview() {
    return (
        <PreviewShell title="Listing alert flow" status="monitor running">
            <div className="grid gap-4 p-4 sm:grid-cols-[1.05fr_0.95fr] sm:p-5">
                <div className="border-border bg-background/70 rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Radio className="size-4 text-emerald-600" />
                            <span className="text-xs font-semibold">
                                Arc&apos;teryx shell
                            </span>
                        </div>
                        <span className="text-[10px] text-emerald-600">
                            NEW
                        </span>
                    </div>
                    <div className="bg-muted mt-5 aspect-4/3 rounded-md p-4">
                        <div className="from-muted-foreground/15 to-muted-foreground/5 h-full rounded bg-linear-to-br" />
                    </div>
                    <p className="mt-4 text-sm font-semibold">
                        Beta AR jacket · size M
                    </p>
                    <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
                        <span>€145 total</span>
                        <span>vinted.de</span>
                    </div>
                </div>
                <div className="space-y-3">
                    {[
                        {
                            icon: LayoutDashboard,
                            label: "Live dashboard",
                            detail: "Full item context",
                        },
                        {
                            icon: MessageCircle,
                            label: "Discord",
                            detail: "Rich webhook alert",
                        },
                        {
                            icon: Send,
                            label: "Telegram",
                            detail: "Connected chat",
                        },
                    ].map((channel) => (
                        <div
                            key={channel.label}
                            className="border-border bg-background/70 flex items-center gap-3 rounded-lg border p-3"
                        >
                            <span className="border-border bg-muted flex size-9 items-center justify-center rounded-md border">
                                <channel.icon className="size-4" />
                            </span>
                            <div>
                                <p className="text-xs font-semibold">
                                    {channel.label}
                                </p>
                                <p className="text-muted-foreground mt-1 text-[10px]">
                                    {channel.detail}
                                </p>
                            </div>
                            <Bell className="ml-auto size-3.5 text-emerald-600" />
                        </div>
                    ))}
                </div>
            </div>
        </PreviewShell>
    );
}

export function PriceWatchPreview() {
    return (
        <PreviewShell title="Price watch" status="watch active">
            <div className="space-y-4 p-4 sm:p-5">
                <div className="border-border bg-background/70 rounded-lg border p-4">
                    <p className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
                        Vinted item URL
                    </p>
                    <div className="border-border bg-muted/45 mt-2 truncate rounded-md border px-3 py-2 text-xs">
                        https://www.vinted.de/items/…
                    </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                    {[
                        ["Current price", "€74"],
                        ["Previous price", "€89"],
                        ["Check interval", "5 min"],
                    ].map(([label, value]) => (
                        <div
                            key={label}
                            className="border-border bg-background/70 rounded-lg border p-3"
                        >
                            <p className="text-muted-foreground text-[10px]">
                                {label}
                            </p>
                            <p className="mt-2 text-lg font-semibold">
                                {value}
                            </p>
                        </div>
                    ))}
                </div>
                <div className="border-border bg-background/70 rounded-lg border p-4">
                    <div className="flex items-center gap-3">
                        <span className="flex size-9 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600">
                            <Timer className="size-4" />
                        </span>
                        <div>
                            <p className="text-sm font-semibold">
                                Price changed by €15
                            </p>
                            <p className="text-muted-foreground mt-1 text-xs">
                                Discord and Telegram notification queued
                            </p>
                        </div>
                        <span className="ml-auto text-xs font-semibold text-emerald-600">
                            -17%
                        </span>
                    </div>
                </div>
            </div>
        </PreviewShell>
    );
}

export function SelfHostedPreview() {
    return (
        <PreviewShell title="Vintrack stack" status="docker compose">
            <div className="grid grid-cols-2 gap-3 p-4 sm:p-5">
                {[
                    {
                        icon: LayoutDashboard,
                        label: "Control center",
                        detail: "Next.js dashboard",
                    },
                    {
                        icon: Server,
                        label: "Monitor worker",
                        detail: "Go catalog sessions",
                    },
                    {
                        icon: Database,
                        label: "PostgreSQL + Redis",
                        detail: "State and deduplication",
                    },
                    {
                        icon: Globe2,
                        label: "Proxy control",
                        detail: "Personal or managed pools",
                    },
                ].map((service) => (
                    <div
                        key={service.label}
                        className="border-border bg-background/70 rounded-lg border p-4"
                    >
                        <service.icon className="size-5" />
                        <p className="mt-5 text-sm font-semibold">
                            {service.label}
                        </p>
                        <p className="text-muted-foreground mt-2 text-xs leading-5">
                            {service.detail}
                        </p>
                    </div>
                ))}
                <div className="border-border col-span-2 flex items-center gap-3 rounded-lg border bg-emerald-500/8 p-4">
                    <CheckCircle2 className="size-5 text-emerald-600" />
                    <p className="text-xs font-semibold">
                        One observable stack, deployed on infrastructure you
                        control.
                    </p>
                </div>
            </div>
        </PreviewShell>
    );
}
