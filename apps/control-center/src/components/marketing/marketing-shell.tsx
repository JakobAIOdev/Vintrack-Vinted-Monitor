import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ArrowRight, Github, MessageCircle, Star } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

const githubUrl = "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor";
const discordUrl = "https://discord.gg/WbEpEjaWjP";
const sneakerDevReviewUrl =
    "https://www.sneakerdev.com/services/e9c9ec35-71a2-43b0-b93b-2c1e8bf2f84d-vintrack";

export function LogoMark({ className = "" }: { className?: string }) {
    return (
        <span
            className={`bg-foreground text-background inline-flex items-center justify-center rounded-md shadow-sm ${className}`}
        >
            <span className="text-xs font-black">V</span>
        </span>
    );
}

export function MarketingHeader() {
    return (
        <header className="border-border bg-background/82 sticky top-0 z-50 border-b backdrop-blur-xl">
            <div className="relative mx-auto flex h-16 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
                <Link
                    href="/"
                    className="flex items-center gap-2.5"
                    aria-label="Vintrack home"
                >
                    <LogoMark className="size-7" />
                    <span className="text-sm font-semibold tracking-tight">
                        Vintrack
                    </span>
                </Link>

                <nav
                    aria-label="Marketing navigation"
                    className="text-muted-foreground absolute left-1/2 hidden -translate-x-1/2 items-center gap-7 text-sm lg:flex"
                >
                    <Link
                        className="hover:text-foreground transition-colors"
                        href="/#product"
                    >
                        Product
                    </Link>
                    <Link
                        className="hover:text-foreground transition-colors"
                        href="/vinted-alerts"
                    >
                        Alerts
                    </Link>
                    <Link
                        className="hover:text-foreground transition-colors"
                        href="/vinted-price-tracker"
                    >
                        Price tracker
                    </Link>
                    <Link
                        className="hover:text-foreground transition-colors"
                        href="/self-hosted-vinted-monitor"
                    >
                        Self-host
                    </Link>
                </nav>

                <div className="ml-auto flex items-center gap-2">
                    <ThemeToggle compact />
                    <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="hidden sm:inline-flex"
                    >
                        <a href={githubUrl} target="_blank" rel="noreferrer">
                            <Github />
                            GitHub
                        </a>
                    </Button>
                    <Button asChild size="sm" className="px-2.5 sm:px-3">
                        <Link href="/login">
                            <span className="hidden min-[380px]:inline">
                                Launch app
                            </span>
                            <span className="min-[380px]:hidden">App</span>
                            <ArrowRight />
                        </Link>
                    </Button>
                </div>
            </div>
        </header>
    );
}

function CtaLink({ href, children }: { href: string; children: ReactNode }) {
    if (href.startsWith("http")) {
        return (
            <a href={href} target="_blank" rel="noreferrer">
                {children}
            </a>
        );
    }

    return <Link href={href}>{children}</Link>;
}

export function MarketingCta({
    title,
    copy,
    primary,
    secondary,
}: {
    title: string;
    copy: string;
    primary: { label: string; href: string };
    secondary: { label: string; href: string };
}) {
    return (
        <section className="border-border bg-muted/18 border-t px-4 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 text-center">
                <div className="border-border bg-card flex size-11 items-center justify-center rounded-md border">
                    <ArrowRight className="size-5" />
                </div>
                <div className="max-w-2xl">
                    <h2 className="text-3xl leading-tight font-semibold sm:text-4xl">
                        {title}
                    </h2>
                    <p className="text-muted-foreground mt-4 text-sm leading-7 sm:text-base">
                        {copy}
                    </p>
                </div>
                <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                    <Button asChild size="lg">
                        <CtaLink href={primary.href}>
                            {primary.label}
                            <ArrowRight />
                        </CtaLink>
                    </Button>
                    <Button asChild variant="outline" size="lg">
                        <CtaLink href={secondary.href}>
                            {secondary.label}
                        </CtaLink>
                    </Button>
                </div>
            </div>
        </section>
    );
}

export function MarketingFooter() {
    const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;

    return (
        <footer className="border-border bg-background border-t px-4 py-10 sm:px-6 lg:px-8">
            <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[1.1fr_0.9fr]">
                <div>
                    <Link
                        href="/"
                        className="text-foreground inline-flex items-center gap-2.5"
                    >
                        <LogoMark className="size-7" />
                        <span className="font-semibold">Vintrack</span>
                    </Link>
                    <p className="text-muted-foreground mt-4 max-w-xl text-sm leading-6">
                        Open-source monitoring for focused Vinted searches,
                        price watches, and fast alerts. Vintrack is independent
                        and is not affiliated with, endorsed by, or operated by
                        Vinted.
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-6 text-sm sm:grid-cols-3">
                    <div className="space-y-3">
                        <p className="text-foreground font-semibold">Product</p>
                        <Link
                            className="text-muted-foreground hover:text-foreground block transition-colors"
                            href="/vinted-alerts"
                        >
                            Listing alerts
                        </Link>
                        <Link
                            className="text-muted-foreground hover:text-foreground block transition-colors"
                            href="/vinted-price-tracker"
                        >
                            Price tracker
                        </Link>
                        <Link
                            className="text-muted-foreground hover:text-foreground block transition-colors"
                            href="/self-hosted-vinted-monitor"
                        >
                            Self-hosting
                        </Link>
                    </div>
                    <div className="space-y-3">
                        <p className="text-foreground font-semibold">
                            Community
                        </p>
                        <a
                            className="text-muted-foreground hover:text-foreground flex items-center gap-2 transition-colors"
                            href={githubUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <Github className="size-4" /> GitHub
                        </a>
                        <a
                            className="text-muted-foreground hover:text-foreground flex items-center gap-2 transition-colors"
                            href={discordUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <MessageCircle className="size-4" /> Discord
                        </a>
                        <a
                            className="text-muted-foreground hover:text-foreground flex items-center gap-2 transition-colors"
                            href={sneakerDevReviewUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <Star className="size-4" /> SneakerDev
                        </a>
                    </div>
                    <div className="space-y-3">
                        <p className="text-foreground font-semibold">Access</p>
                        <Link
                            className="text-muted-foreground hover:text-foreground block transition-colors"
                            href="/login"
                        >
                            Live demo
                        </Link>
                        <span className="text-muted-foreground block">
                            MIT licensed
                        </span>
                        {appVersion ? (
                            <span className="text-muted-foreground block">
                                v{appVersion}
                            </span>
                        ) : null}
                    </div>
                </div>
            </div>
        </footer>
    );
}
