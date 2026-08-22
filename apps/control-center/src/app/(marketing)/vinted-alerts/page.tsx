import {
    AlertPreview,
    BreadcrumbJsonLd,
    FaqSection,
    MarketingPageHero,
    MarketingSectionHeading,
} from "@/components/marketing/marketing-page";
import { MarketingCta } from "@/components/marketing/marketing-shell";
import { buildMarketingMetadata } from "@/lib/seo";
import {
    Bell,
    CheckCircle2,
    Filter,
    LayoutDashboard,
    MessageCircle,
    Search,
    Send,
    SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";

export function generateMetadata() {
    return buildMarketingMetadata({
        title: "Vinted Alerts for New Listings | Vintrack",
        description:
            "Get filtered Vinted new-listing alerts in Discord, Telegram, and a live dashboard. Start with the hosted demo or self-host Vintrack.",
        path: "/vinted-alerts",
    });
}

const githubUrl = "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor";

const faqItems = [
    {
        question: "How do Vintrack Vinted alerts work?",
        answer: "You create a monitor with a Vinted market, search query, filters, interval, and proxy source. Vintrack checks that search and sends newly matched listings to the channels enabled for that monitor.",
    },
    {
        question: "Can alerts go to both Discord and Telegram?",
        answer: "Yes. A monitor can deliver the same match to the live dashboard, a Discord webhook, and a connected Telegram chat. Each channel is configured independently.",
    },
    {
        question: "Can I try Vinted alerts for free?",
        answer: "The hosted demo gives new members a Free role. When a regional starter proxy pool is healthy and available, it can be used to test catalog monitoring before adding personal proxies. Shared pools remain best-effort infrastructure.",
    },
    {
        question: "Is Vintrack a Vinted bot?",
        answer: "Vintrack is an independent monitoring tool that watches configured listing searches and sends alerts. Optional linked-account tools are separate, explicitly authorized features. Vintrack does not automate payment and is not affiliated with Vinted.",
    },
];

export default function VintedAlertsPage() {
    return (
        <main className="overflow-x-hidden">
            <BreadcrumbJsonLd name="Vinted alerts" path="/vinted-alerts" />
            <MarketingPageHero
                kicker="Vinted new-listing alerts"
                title="Get Vinted alerts when matching listings appear."
                copy="Stop refreshing the same search manually. Vintrack keeps focused monitors running and routes readable new-listing matches to your dashboard, Discord, or Telegram."
                primary={{ label: "Start monitoring", href: "/login" }}
                secondary={{
                    label: "View self-hosting",
                    href: "/self-hosted-vinted-monitor",
                }}
                note="Shared free proxy pools are best-effort and only appear when a regional pool is healthy enough to use."
                visual={<AlertPreview />}
            />

            <section className="border-border border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-6xl">
                    <MarketingSectionHeading
                        kicker="Focused workflow"
                        title="From a precise search to a useful alert."
                        copy="Vintrack preserves the details that help you judge a listing instead of sending a bare link with no context."
                    />
                    <div className="mt-10 grid gap-5 md:grid-cols-3">
                        {[
                            {
                                icon: SlidersHorizontal,
                                step: "01",
                                title: "Define the match",
                                copy: "Choose the Vinted market, search terms, price, category, brand, size, color, condition, and seller-country filters you need.",
                            },
                            {
                                icon: Search,
                                step: "02",
                                title: "Run the monitor",
                                copy: "Select a personal, managed, or currently available starter proxy source and set a responsible query interval.",
                            },
                            {
                                icon: Bell,
                                step: "03",
                                title: "Receive the find",
                                copy: "Review the item image, price, size, seller context, monitor source, and direct Vinted link in the channels you enabled.",
                            },
                        ].map((step) => (
                            <article
                                key={step.step}
                                className="border-border bg-card rounded-lg border p-6"
                            >
                                <div className="flex items-center justify-between">
                                    <step.icon className="size-5" />
                                    <span className="text-muted-foreground text-xs font-semibold">
                                        {step.step}
                                    </span>
                                </div>
                                <h3 className="mt-6 text-lg font-semibold">
                                    {step.title}
                                </h3>
                                <p className="text-muted-foreground mt-3 text-sm leading-7">
                                    {step.copy}
                                </p>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section className="border-border bg-muted/18 border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
                    <MarketingSectionHeading
                        kicker="Filter before delivery"
                        title="Keep broad searches from becoming noisy feeds."
                        copy="Each monitor stores its own search intent, notification choices, query delay, and proxy source. Change one monitor without disturbing the rest."
                    />
                    <div className="grid gap-4 sm:grid-cols-2">
                        {[
                            [
                                "Search intent",
                                "Keywords and title-only matching",
                            ],
                            [
                                "Catalog context",
                                "Market, category, brand, and color",
                            ],
                            [
                                "Fit and condition",
                                "Clothing sizes, shoe sizes, and condition",
                            ],
                            ["Price control", "Minimum and maximum item price"],
                            [
                                "Seller location",
                                "Country-based filtering where available",
                            ],
                            [
                                "Delivery",
                                "Dashboard, Discord, and Telegram per monitor",
                            ],
                        ].map(([title, copy]) => (
                            <div
                                key={title}
                                className="border-border bg-background rounded-lg border p-5"
                            >
                                <Filter className="size-4" />
                                <h3 className="mt-4 text-sm font-semibold">
                                    {title}
                                </h3>
                                <p className="text-muted-foreground mt-2 text-sm leading-6">
                                    {copy}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            <section className="border-border border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                    <AlertPreview />
                    <div>
                        <MarketingSectionHeading
                            kicker="One match, useful everywhere"
                            title="Choose the channel without losing item context."
                            copy="The same monitor can support a visual live feed and message-based alerts, so you can decide where to review a find."
                        />
                        <div className="mt-7 space-y-4">
                            {[
                                {
                                    icon: LayoutDashboard,
                                    title: "Live dashboard",
                                    copy: "A persistent stream with monitor source and listing details.",
                                },
                                {
                                    icon: MessageCircle,
                                    title: "Discord webhooks",
                                    copy: "Rich alerts delivered to a server and channel you control.",
                                },
                                {
                                    icon: Send,
                                    title: "Connected Telegram",
                                    copy: "Per-user chat delivery without sharing a bot token or numeric chat ID.",
                                },
                            ].map((channel) => (
                                <div
                                    key={channel.title}
                                    className="flex items-start gap-3"
                                >
                                    <span className="border-border bg-muted flex size-9 shrink-0 items-center justify-center rounded-md border">
                                        <channel.icon className="size-4" />
                                    </span>
                                    <div>
                                        <h3 className="text-sm font-semibold">
                                            {channel.title}
                                        </h3>
                                        <p className="text-muted-foreground mt-1 text-sm leading-6">
                                            {channel.copy}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            <section className="px-4 py-16 sm:px-6 lg:px-8">
                <div className="border-border bg-card mx-auto flex max-w-6xl flex-col gap-5 rounded-xl border p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between">
                    <div className="max-w-3xl">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <CheckCircle2 className="size-4 text-emerald-600" />
                            Transparent monitoring boundaries
                        </div>
                        <p className="text-muted-foreground mt-3 text-sm leading-7">
                            Free proxy availability and delivery speed vary by
                            region and current pool health. Bring personal
                            proxies when you need dedicated capacity, and use
                            Vintrack responsibly with intervals appropriate for
                            your setup.
                        </p>
                    </div>
                    <Link
                        href="/self-hosted-vinted-monitor"
                        className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold"
                    >
                        See deployment options{" "}
                        <CheckCircle2 className="size-4" />
                    </Link>
                </div>
            </section>

            <FaqSection items={faqItems} />
            <MarketingCta
                title="Create your first focused Vinted alert."
                copy="Use the hosted demo with an available starter pool, or run Vintrack with infrastructure you control."
                primary={{ label: "Start monitoring", href: "/login" }}
                secondary={{ label: "View on GitHub", href: githubUrl }}
            />
        </main>
    );
}
