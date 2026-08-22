import {
    BreadcrumbJsonLd,
    FaqSection,
    MarketingPageHero,
    MarketingSectionHeading,
    PriceWatchPreview,
} from "@/components/marketing/marketing-page";
import { MarketingCta } from "@/components/marketing/marketing-shell";
import { buildMarketingMetadata } from "@/lib/seo";
import {
    Bell,
    CheckCircle2,
    Clock3,
    Link2,
    MessageCircle,
    RefreshCw,
    Send,
    Timer,
} from "lucide-react";
import Link from "next/link";

export function generateMetadata() {
    return buildMarketingMetadata({
        title: "Vinted Price Tracker & Price Drop Alerts | Vintrack",
        description:
            "Track individual Vinted item prices and receive price drop alerts in Discord or Telegram. Use the hosted demo or self-host Vintrack.",
        path: "/vinted-price-tracker",
    });
}

const githubUrl = "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor";

const faqItems = [
    {
        question: "What does the Vintrack price tracker watch?",
        answer: "Price Watch follows a specific Vinted item URL. It stores the canonical item target separately from its polling schedule and records the current watch status when Vintrack checks it.",
    },
    {
        question: "How do I receive a Vinted price drop alert?",
        answer: "Enable notifications on the watch and choose Discord, Telegram, or both. Vintrack sends an alert when the tracked item price is lowered according to the configured watch behavior.",
    },
    {
        question: "Do I need to link my Vinted account?",
        answer: "No linked account is required just to monitor an individual public item price. Linked-account tools are separate and only needed for authorized actions such as likes, offers, messages, or checkout links.",
    },
    {
        question: "Can I self-host the Vinted price tracker?",
        answer: "Yes. Price Watch is part of the same open-source Vintrack stack. A self-hosted operator controls deployment, users, proxy capacity, notification credentials, and polling policy.",
    },
];

export default function VintedPriceTrackerPage() {
    return (
        <main className="overflow-x-hidden">
            <BreadcrumbJsonLd
                name="Vinted price tracker"
                path="/vinted-price-tracker"
            />
            <MarketingPageHero
                kicker="Vinted price watch"
                title="Track Vinted price drops without checking manually."
                copy="Paste an individual Vinted item link, choose how often Vintrack should check it, and route price-change notifications to Discord or Telegram."
                primary={{ label: "Start price tracking", href: "/login" }}
                secondary={{
                    label: "View self-hosting",
                    href: "/self-hosted-vinted-monitor",
                }}
                note="Price Watch follows existing item URLs. Use a listing monitor when you want alerts for newly posted items matching a search."
                visual={<PriceWatchPreview />}
            />

            <section className="border-border border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
                    <MarketingSectionHeading
                        kicker="Two different jobs"
                        title="Use a price watch when the item already exists."
                        copy="A listing monitor searches for new matches. A price watch follows one known listing. Keeping them separate makes each schedule and alert easier to understand."
                    />
                    <div className="grid gap-5 sm:grid-cols-2">
                        <article className="border-border bg-card rounded-lg border p-6">
                            <Timer className="size-5" />
                            <p className="text-muted-foreground mt-5 text-[11px] font-semibold tracking-wider uppercase">
                                Price Watch
                            </p>
                            <h3 className="mt-2 text-xl font-semibold">
                                Follow one item URL
                            </h3>
                            <p className="text-muted-foreground mt-3 text-sm leading-7">
                                Use it for a listing you already know and want
                                to revisit when its price changes.
                            </p>
                        </article>
                        <article className="border-border bg-muted/35 rounded-lg border p-6">
                            <RefreshCw className="size-5" />
                            <p className="text-muted-foreground mt-5 text-[11px] font-semibold tracking-wider uppercase">
                                Listing Monitor
                            </p>
                            <h3 className="mt-2 text-xl font-semibold">
                                Discover new matching items
                            </h3>
                            <p className="text-muted-foreground mt-3 text-sm leading-7">
                                Use it for a saved search with keywords, catalog
                                filters, and a stream of new finds.
                            </p>
                            <Link
                                href="/vinted-alerts"
                                className="mt-5 inline-flex items-center gap-2 text-sm font-semibold"
                            >
                                Explore listing alerts{" "}
                                <Bell className="size-4" />
                            </Link>
                        </article>
                    </div>
                </div>
            </section>

            <section className="border-border bg-muted/18 border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-6xl">
                    <MarketingSectionHeading
                        kicker="Simple workflow"
                        title="Turn a Vinted link into a controlled watch."
                        copy="The target, schedule, proxy choice, and delivery channels stay visible in one dashboard instead of being spread across reminders and browser tabs."
                    />
                    <div className="mt-10 grid gap-5 md:grid-cols-3">
                        {[
                            {
                                icon: Link2,
                                step: "01",
                                title: "Paste the item URL",
                                copy: "Vintrack validates the supported Vinted link and stores its canonical item target.",
                            },
                            {
                                icon: Clock3,
                                step: "02",
                                title: "Choose the schedule",
                                copy: "Set how often the watch should check and select shared or personal proxy capacity where available.",
                            },
                            {
                                icon: Bell,
                                step: "03",
                                title: "Enable delivery",
                                copy: "Send a price-drop notification to Discord, Telegram, or both without changing other watches.",
                            },
                        ].map((step) => (
                            <article
                                key={step.step}
                                className="border-border bg-background rounded-lg border p-6"
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

            <section className="border-border border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
                    <PriceWatchPreview />
                    <div>
                        <MarketingSectionHeading
                            kicker="Delivery and control"
                            title="Keep every watch independent."
                            copy="Different items can use different schedules and notification choices, while the watch list keeps active and paused targets easy to inspect."
                        />
                        <div className="mt-7 space-y-4">
                            {[
                                {
                                    icon: MessageCircle,
                                    title: "Discord",
                                    copy: "Send price changes through a webhook you control.",
                                },
                                {
                                    icon: Send,
                                    title: "Telegram",
                                    copy: "Deliver changes to a connected Vintrack chat.",
                                },
                                {
                                    icon: CheckCircle2,
                                    title: "Visible state",
                                    copy: "Review whether a watch is active, paused, or stopped from the dashboard.",
                                },
                            ].map((feature) => (
                                <div
                                    key={feature.title}
                                    className="flex items-start gap-3"
                                >
                                    <span className="border-border bg-muted flex size-9 shrink-0 items-center justify-center rounded-md border">
                                        <feature.icon className="size-4" />
                                    </span>
                                    <div>
                                        <h3 className="text-sm font-semibold">
                                            {feature.title}
                                        </h3>
                                        <p className="text-muted-foreground mt-1 text-sm leading-6">
                                            {feature.copy}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            <section className="px-4 py-16 sm:px-6 lg:px-8">
                <div className="border-border bg-card mx-auto max-w-6xl rounded-xl border p-6 sm:p-8">
                    <div className="flex items-start gap-4">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-600">
                            <Clock3 className="size-5" />
                        </span>
                        <div>
                            <h2 className="text-lg font-semibold">
                                A price tracker reports changes; it does not
                                reserve an item.
                            </h2>
                            <p className="text-muted-foreground mt-3 text-sm leading-7">
                                Listing availability can change between checks.
                                Vintrack keeps monitoring and optional account
                                actions separate, and final purchases remain in
                                Vinted&apos;s native checkout.
                            </p>
                        </div>
                    </div>
                </div>
            </section>

            <FaqSection items={faqItems} />
            <MarketingCta
                title="Watch the price of an item you already found."
                copy="Start in the hosted dashboard or deploy the open-source stack with your own notification and proxy configuration."
                primary={{ label: "Start price tracking", href: "/login" }}
                secondary={{ label: "View on GitHub", href: githubUrl }}
            />
        </main>
    );
}
