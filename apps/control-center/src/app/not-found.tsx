import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Home, PackageSearch, Radio } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
    title: "404 – Page not found | Vintrack",
    description: "This page does not exist.",
    robots: {
        index: false,
        follow: false,
    },
};

export default function NotFound() {
    return (
        <div className="bg-background text-foreground relative min-h-screen overflow-hidden">
            {/* Background – mirrors the login page gradient */}
            <div className="absolute inset-0 -z-10">
                <div
                    className="absolute inset-0"
                    style={{
                        background:
                            "radial-gradient(circle at top left, rgba(14,165,233,0.12), transparent 34%), radial-gradient(circle at 88% 14%, rgba(245,158,11,0.12), transparent 28%), linear-gradient(180deg, color-mix(in oklab, var(--background) 86%, white 14%), var(--background))",
                    }}
                />
                {/* Grid overlay */}
                <div className="landing-grid absolute inset-0 opacity-30" />
                <div className="absolute top-24 -left-48 h-80 w-80 rounded-full bg-sky-500/10 blur-3xl" />
                <div className="absolute -right-20 -bottom-32 h-72 w-72 rounded-full bg-amber-400/10 blur-3xl" />
                <div className="via-border absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent to-transparent" />
            </div>

            {/* Header */}
            <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 sm:px-8">
                <Link href="/" className="flex items-center gap-3">
                    <div className="bg-foreground text-background flex h-10 w-10 items-center justify-center rounded-lg shadow-lg shadow-slate-950/10">
                        <span className="text-sm leading-none font-black">V</span>
                    </div>
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.32em] uppercase">
                            Vintrack
                        </p>
                        <p className="text-foreground text-sm font-medium">
                            Vinted monitoring control center
                        </p>
                    </div>
                </Link>

                <ThemeToggle compact />
            </header>

            {/* Main */}
            <main className="mx-auto flex min-h-[calc(100vh-88px)] w-full max-w-7xl flex-col items-center justify-center gap-10 px-6 pb-20 text-center sm:px-8">
                {/* Illustration card */}
                <div className="relative w-full max-w-sm">
                    <div className="absolute inset-6 rounded-[2rem] bg-slate-950/8 blur-2xl dark:bg-black/20" />
                    <div className="border-border/70 bg-card/88 relative overflow-hidden rounded-[2rem] border p-8 shadow-2xl shadow-slate-950/10 backdrop-blur-xl">
                        {/* Subtle inner grid */}
                        <div className="absolute inset-0 opacity-20">
                            <div className="landing-grid h-full w-full" />
                        </div>
                        <div className="from-card/80 absolute inset-x-0 bottom-0 h-24 bg-linear-to-t to-transparent" />

                        <div className="relative flex flex-col items-center gap-5">
                            {/* Icon with pulse ring */}
                            <div className="relative">
                                <div className="absolute inset-0 animate-ping rounded-full bg-sky-500/15" style={{ animationDuration: "2.4s" }} />
                                <div className="bg-foreground text-background relative flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg">
                                    <PackageSearch className="h-8 w-8" />
                                </div>
                            </div>

                            {/* 404 badge */}
                            <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/20 bg-sky-500/10 px-4 py-1.5 text-[11px] font-semibold tracking-[0.28em] text-sky-700 uppercase dark:text-sky-300">
                                <Radio className="h-3 w-3" />
                                Error 404
                            </div>

                            {/* Copy */}
                            <div className="space-y-2">
                                <h1 className="text-foreground text-3xl font-black tracking-tight">
                                    Nothing here.
                                </h1>
                                <p className="text-muted-foreground text-sm leading-7">
                                    This page doesn&apos;t exist or was moved.
                                    <br />
                                    Head back to the dashboard and keep monitoring.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* CTAs */}
                <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button asChild size="lg" className="h-11 rounded-2xl px-6 font-semibold shadow-lg shadow-slate-950/10">
                        <Link href="/dashboard">
                            <Home className="h-4 w-4" />
                            Go to Dashboard
                        </Link>
                    </Button>
                    <Button asChild variant="outline" size="lg" className="h-11 rounded-2xl px-6 font-semibold">
                        <Link href="javascript:history.back()">
                            <ArrowLeft className="h-4 w-4" />
                            Go back
                        </Link>
                    </Button>
                </div>

                {/* Quick links */}
                <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                    {[
                        { href: "/feed", label: "Live Feed" },
                        { href: "/account", label: "Account" },
                        { href: "/proxies", label: "Proxy Groups" },
                        { href: "/guide", label: "Guide" },
                    ].map((link) => (
                        <Link
                            key={link.href}
                            href={link.href}
                            className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
                        >
                            {link.label}
                        </Link>
                    ))}
                </div>
            </main>
        </div>
    );
}
