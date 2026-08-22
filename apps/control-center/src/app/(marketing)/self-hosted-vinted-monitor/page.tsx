import {
    BreadcrumbJsonLd,
    FaqSection,
    MarketingPageHero,
    MarketingSectionHeading,
    SelfHostedPreview,
} from "@/components/marketing/marketing-page";
import { MarketingCta } from "@/components/marketing/marketing-shell";
import { buildMarketingMetadata } from "@/lib/seo";
import {
    Bell,
    CheckCircle2,
    Database,
    Globe2,
    KeyRound,
    LayoutDashboard,
    Server,
    ShieldCheck,
    SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";

export function generateMetadata() {
    return buildMarketingMetadata({
        title: "Self-Hosted Open-Source Vinted Monitor | Vintrack",
        description:
            "Run an open-source Vinted monitor with Docker Compose, Go workers, a Next.js dashboard, PostgreSQL, Redis, and your own proxy setup.",
        path: "/self-hosted-vinted-monitor",
    });
}

const githubUrl = "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor";

const faqItems = [
    {
        question: "What do I need to self-host Vintrack?",
        answer: "The guided setup expects Docker Engine with Docker Compose v2, Git, Make, and OpenSSL. A public production deployment also needs a domain, HTTPS, and a configured Discord OAuth or OIDC provider.",
    },
    {
        question: "Can I use my own Vinted proxies?",
        answer: "Yes. Vintrack supports personal and server-managed proxy groups alongside optional shared starter pools. Self-hosted operators control which sources and regional capacity their users can access.",
    },
    {
        question: "Where does self-hosted Vintrack store data?",
        answer: "The stack uses PostgreSQL for persistent application data and Redis for coordination, caching, deduplication, and live state. You control the host, volumes, backups, secrets, and retention configuration.",
    },
    {
        question: "How is self-hosting different from the live demo?",
        answer: "The demo is shared, best-effort infrastructure with operator-defined role limits. A self-hosted deployment gives you administrative control over users, proxy capacity, intervals, notifications, domains, and deployment policy.",
    },
];

export default function SelfHostedVintedMonitorPage() {
    return (
        <main className="overflow-x-hidden">
            <BreadcrumbJsonLd
                name="Self-hosted Vinted monitor"
                path="/self-hosted-vinted-monitor"
            />
            <MarketingPageHero
                kicker="Open-source Vinted monitoring"
                title="Run your own open-source Vinted monitor."
                copy="Deploy Vintrack as one observable Docker Compose stack with focused listing monitors, a live dashboard, Discord and Telegram alerts, proxy controls, and optional linked-account tools."
                primary={{ label: "View on GitHub", href: githubUrl }}
                secondary={{ label: "Try live demo", href: "/login" }}
                note="MIT licensed. You remain responsible for deployment security, request policy, data handling, and compliance with third-party terms."
                visual={<SelfHostedPreview />}
            />

            <section className="border-border border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.82fr_1.18fr] lg:items-start">
                    <MarketingSectionHeading
                        kicker="Infrastructure you control"
                        title="Keep the dashboard and monitor pipeline in one stack."
                        copy="Vintrack separates catalog monitoring, account actions, persistence, and live coordination into maintained services without hiding their operational state."
                    />
                    <div className="grid gap-4 sm:grid-cols-2">
                        {[
                            {
                                icon: LayoutDashboard,
                                title: "Next.js control center",
                                copy: "Manage searches, feeds, users, proxy groups, price watches, alerts, and optional account tools.",
                            },
                            {
                                icon: Server,
                                title: "Go monitor workers",
                                copy: "Run isolated regional catalog sessions with bounded attempts and Redis-backed deduplication.",
                            },
                            {
                                icon: Database,
                                title: "PostgreSQL and Redis",
                                copy: "Persist application state while coordinating live feeds, caches, and new-listing delivery.",
                            },
                            {
                                icon: Globe2,
                                title: "Proxy ownership",
                                copy: "Use personal, server-managed, or optional health-checked starter pools by region.",
                            },
                        ].map((service) => (
                            <article
                                key={service.title}
                                className="border-border bg-card rounded-lg border p-6"
                            >
                                <service.icon className="size-5" />
                                <h3 className="mt-5 text-lg font-semibold">
                                    {service.title}
                                </h3>
                                <p className="text-muted-foreground mt-3 text-sm leading-7">
                                    {service.copy}
                                </p>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section className="border-border bg-muted/18 border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1fr_1fr] lg:items-center">
                    <div>
                        <MarketingSectionHeading
                            kicker="Guided start"
                            title="Bring up the complete local stack with the repository workflow."
                            copy="The initializer creates the local environment file, fills missing placeholder secrets, and preserves an existing configuration. Review every production value before exposing the service publicly."
                        />
                        <div className="mt-7 space-y-3">
                            {[
                                "Docker Engine with Docker Compose v2",
                                "Git, Make, and OpenSSL",
                                "Discord OAuth or an OIDC provider",
                                "A public domain and HTTPS for production",
                            ].map((requirement) => (
                                <div
                                    key={requirement}
                                    className="flex items-center gap-3 text-sm"
                                >
                                    <CheckCircle2 className="size-4 text-emerald-600" />
                                    {requirement}
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="border-border rounded-xl border bg-zinc-950 p-5 text-zinc-100 shadow-2xl">
                        <div className="flex items-center justify-between border-b border-white/10 pb-4">
                            <div className="flex gap-2">
                                <span className="size-2 rounded-full bg-rose-400" />
                                <span className="size-2 rounded-full bg-amber-400" />
                                <span className="size-2 rounded-full bg-emerald-400" />
                            </div>
                            <span className="text-xs text-zinc-400">
                                terminal
                            </span>
                        </div>
                        <pre className="mt-5 overflow-x-auto text-xs leading-7 sm:text-sm">
                            <code>{`git clone ${githubUrl}.git vintrack
cd vintrack
make init
docker compose up -d --build`}</code>
                        </pre>
                        <p className="mt-5 border-t border-white/10 pt-4 text-xs leading-6 text-zinc-400">
                            Read the configuration and production deployment
                            guides before opening ports or registering auth
                            callbacks.
                        </p>
                    </div>
                </div>
            </section>

            <section className="border-border border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-6xl">
                    <MarketingSectionHeading
                        kicker="Choose the operating model"
                        title="Try shared infrastructure or own every deployment decision."
                        copy="Both paths use the same product. The difference is who controls capacity, configuration, users, and ongoing operations."
                    />
                    <div className="border-border mt-10 overflow-hidden rounded-xl border">
                        <div className="grid grid-cols-[1fr_0.9fr_0.9fr] border-b text-xs font-semibold sm:text-sm">
                            <div className="bg-muted/35 p-4">Capability</div>
                            <div className="bg-muted/35 p-4">Hosted demo</div>
                            <div className="bg-muted/35 p-4">Self-hosted</div>
                        </div>
                        {[
                            ["Setup", "Sign in", "Deploy and configure"],
                            [
                                "Users and roles",
                                "Demo policy",
                                "Operator controlled",
                            ],
                            [
                                "Proxy capacity",
                                "Shared or personal",
                                "Operator controlled",
                            ],
                            [
                                "Data and backups",
                                "Demo managed",
                                "Operator controlled",
                            ],
                            ["Updates", "Automatic", "Operator scheduled"],
                        ].map(([capability, hosted, selfHosted]) => (
                            <div
                                key={capability}
                                className="border-border grid grid-cols-[1fr_0.9fr_0.9fr] border-b last:border-b-0"
                            >
                                <div className="p-4 text-xs font-semibold sm:text-sm">
                                    {capability}
                                </div>
                                <div className="text-muted-foreground p-4 text-xs sm:text-sm">
                                    {hosted}
                                </div>
                                <div className="text-muted-foreground p-4 text-xs sm:text-sm">
                                    {selfHosted}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            <section className="border-border bg-muted/18 border-b px-4 py-20 sm:px-6 lg:px-8">
                <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
                    <MarketingSectionHeading
                        kicker="Operational boundaries"
                        title="Transparent control comes with responsibility."
                        copy="Vintrack documents the boundaries between public catalog monitoring, explicitly authorized account actions, and Vinted's native checkout."
                    />
                    <div className="space-y-4">
                        {[
                            {
                                icon: ShieldCheck,
                                title: "Respect access controls",
                                copy: "Do not use Vintrack to bypass authentication barriers, CAPTCHAs, rate limits, or other controls.",
                            },
                            {
                                icon: KeyRound,
                                title: "Protect deployment secrets",
                                copy: "Keep OAuth credentials, proxy passwords, webhooks, session data, and encryption keys out of source and logs.",
                            },
                            {
                                icon: SlidersHorizontal,
                                title: "Set responsible policy",
                                copy: "Choose intervals, capacity, retention, users, and linked-account access appropriate for your environment.",
                            },
                        ].map((boundary) => (
                            <article
                                key={boundary.title}
                                className="border-border bg-background flex gap-4 rounded-lg border p-5"
                            >
                                <boundary.icon className="mt-0.5 size-5 shrink-0" />
                                <div>
                                    <h3 className="text-sm font-semibold">
                                        {boundary.title}
                                    </h3>
                                    <p className="text-muted-foreground mt-2 text-sm leading-6">
                                        {boundary.copy}
                                    </p>
                                </div>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section className="px-4 py-14 sm:px-6 lg:px-8">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5">
                    <div>
                        <p className="text-sm font-semibold">
                            Prefer to see the product before deploying it?
                        </p>
                        <p className="text-muted-foreground mt-2 text-sm">
                            The hosted demo exposes the same dashboard workflow
                            with shared-role limits.
                        </p>
                    </div>
                    <Link
                        href="/vinted-alerts"
                        className="inline-flex items-center gap-2 text-sm font-semibold"
                    >
                        Explore listing alerts <Bell className="size-4" />
                    </Link>
                </div>
            </section>

            <FaqSection items={faqItems} />
            <MarketingCta
                title="Inspect the stack, then run it your way."
                copy="Read the repository documentation, configure the public origin and authentication carefully, and keep the deployment under your control."
                primary={{ label: "View on GitHub", href: githubUrl }}
                secondary={{ label: "Try live demo", href: "/login" }}
            />
        </main>
    );
}
