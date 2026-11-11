import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Home, PackageSearch } from "lucide-react";
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
            {/* Header */}
            <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 sm:px-8">
                <Link href="/" className="flex items-center gap-3">
                    <div className="bg-foreground text-background flex h-8 w-8 items-center justify-center rounded-lg">
                        <span className="text-sm leading-none font-semibold">
                            V
                        </span>
                    </div>
                    <div>
                        <p className="text-foreground text-[15px] font-semibold">
                            Vintrack
                        </p>
                        <p className="text-muted-foreground text-xs">
                            Vinted monitoring control center
                        </p>
                    </div>
                </Link>

                <ThemeToggle compact />
            </header>

            {/* Main */}
            <main className="mx-auto flex min-h-[calc(100vh-88px)] w-full max-w-7xl flex-col items-center justify-center gap-8 px-6 pb-20 text-center sm:px-8">
                <div className="flex max-w-sm flex-col items-center gap-4">
                    <PackageSearch className="text-muted-foreground h-8 w-8" />
                    <p className="text-muted-foreground font-mono text-xs">
                        404
                    </p>
                    <div className="space-y-2">
                        <h1 className="text-foreground text-3xl font-semibold tracking-tight">
                            Page not found
                        </h1>
                        <p className="text-muted-foreground text-sm leading-6">
                            This page does not exist or was moved
                        </p>
                    </div>
                </div>

                {/* CTAs */}
                <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button
                        asChild
                        size="lg"
                        className="h-10 rounded-lg px-5 font-medium"
                    >
                        <Link href="/dashboard">
                            <Home className="h-4 w-4" />
                            Go to dashboard
                        </Link>
                    </Button>
                    <Button
                        asChild
                        variant="outline"
                        size="lg"
                        className="h-10 rounded-lg px-5 font-medium"
                    >
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
