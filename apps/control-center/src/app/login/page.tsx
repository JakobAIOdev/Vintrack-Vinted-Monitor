import { auth, githubAuthConfigured, signIn } from "@/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
    ArrowRight,
    Bell,
    Github,
    KeyRound,
    ShieldCheck,
    Sparkles,
    Zap,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { oidcConfigured, oidcName } from "@/lib/auth-provider";

export const metadata: Metadata = {
    title: "Login | Vintrack",
    description: "Sign in to access the Vintrack dashboard.",
    robots: {
        index: false,
        follow: false,
    },
};

async function signInWithDiscord() {
    "use server";

    await signIn("discord", { redirectTo: "/dashboard" });
}

async function signInWithOidc() {
    "use server";

    await signIn("oidc", { redirectTo: "/dashboard" });
}

const highlights = [
    {
        icon: Zap,
        title: "Realtime monitors",
        copy: "Sub-second item detection across your active searches.",
    },
    {
        icon: Bell,
        title: "Instant alerts",
        copy: "Discord and Telegram alerts, live feed updates and linked account actions.",
    },
    {
        icon: ShieldCheck,
        title: "Protected dashboard",
        copy: "Every internal dashboard route now requires an authenticated session.",
    },
];

export default async function LoginPage({
    searchParams,
}: {
    searchParams?: Promise<{ error?: string }>;
}) {
    const session = await auth();
    const error = (await searchParams)?.error;

    if (session?.user && error) {
        redirect(
            `/account?connection=github&github=error&reason=${encodeURIComponent(error)}`,
        );
    }
    if (session?.user) {
        redirect("/dashboard");
    }

    return (
        <div className="bg-background text-foreground relative min-h-screen overflow-hidden">
            <div className="absolute inset-0 -z-10">
                <div
                    className="absolute inset-0"
                    style={{
                        background:
                            "radial-gradient(circle at top left, rgba(14,165,233,0.16), transparent 32%), radial-gradient(circle at 85% 18%, rgba(245,158,11,0.16), transparent 24%), linear-gradient(180deg, color-mix(in oklab, var(--background) 86%, white 14%), var(--background))",
                    }}
                />
                <div className="absolute top-24 -left-48 h-80 w-80 rounded-full bg-sky-500/12 blur-3xl" />
                <div className="absolute -right-20 -bottom-32 h-72 w-72 rounded-full bg-amber-400/12 blur-3xl" />
                <div className="via-border absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent to-transparent" />
            </div>

            <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 sm:px-8">
                <Link href="/" className="flex items-center gap-3">
                    <div className="bg-foreground text-background flex h-10 w-10 items-center justify-center rounded-lg shadow-lg shadow-slate-950/10">
                        <span className="text-sm leading-none font-black">
                            V
                        </span>
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

            <main className="mx-auto grid min-h-[calc(100vh-88px)] w-full max-w-7xl items-center gap-10 px-6 pb-10 sm:px-8 lg:grid-cols-[1.15fr_0.85fr]">
                <section className="max-w-2xl space-y-8 py-8 lg:py-16">
                    <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.28em] text-sky-700 uppercase dark:text-sky-300">
                        <Sparkles className="h-3.5 w-3.5" />
                        Members Dashboard
                    </div>

                    <div className="space-y-5">
                        <h1 className="max-w-xl text-5xl font-black tracking-tight text-balance sm:text-6xl">
                            Secure access for the whole dashboard.
                        </h1>
                        <p className="text-muted-foreground max-w-xl text-base leading-8 sm:text-lg">
                            {oidcConfigured
                                ? `Sign in with ${oidcName} to open monitors, feed, chats, likes, proxies and account tools from one protected workspace.`
                                : "Sign in with Discord to open monitors, feed, chats, likes, proxies and account tools from one protected workspace."}
                        </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                        {highlights.map((item) => (
                            <div
                                key={item.title}
                                className="border-border/70 bg-card/80 rounded-3xl border p-5 shadow-lg shadow-slate-950/5 backdrop-blur-sm"
                            >
                                <div className="bg-foreground text-background mb-4 flex h-11 w-11 items-center justify-center rounded-2xl">
                                    <item.icon className="h-5 w-5" />
                                </div>
                                <h2 className="text-foreground text-sm font-semibold">
                                    {item.title}
                                </h2>
                                <p className="text-muted-foreground mt-2 text-sm leading-6">
                                    {item.copy}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="relative">
                    <div className="absolute inset-6 rounded-[2rem] bg-slate-950/8 blur-2xl dark:bg-black/20" />
                    <div className="border-border/70 bg-card/88 relative overflow-hidden rounded-[2rem] border p-6 shadow-2xl shadow-slate-950/10 backdrop-blur-xl sm:p-8">
                        <div className="mb-8 flex items-start justify-between gap-4">
                            <div>
                                <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.28em] uppercase">
                                    {oidcConfigured
                                        ? `${oidcName} Access`
                                        : "Discord Access"}
                                </p>
                                <h2 className="mt-2 text-3xl font-bold tracking-tight">
                                    Enter Vintrack
                                </h2>
                            </div>
                            <div className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                                Auth required
                            </div>
                        </div>

                        <div className="border-border/70 bg-background/70 space-y-4 rounded-[1.5rem] border p-5">
                            {error ? (
                                <div
                                    role="alert"
                                    className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-700 dark:text-red-300"
                                >
                                    {error === "OAuthAccountNotLinked" ||
                                    error === "AccessDenied"
                                        ? "That GitHub account cannot be used to sign in. Sign in with your usual provider below, then connect GitHub from Account. Accounts are never merged by email automatically."
                                        : "Authentication could not be completed. Please try again or use your existing login provider."}
                                </div>
                            ) : null}
                            <p className="text-muted-foreground text-sm leading-7">
                                {oidcConfigured
                                    ? `Use your ${oidcName} account to authenticate. After login you will be redirected directly into the dashboard.`
                                    : "Use your Discord account to authenticate. After login you will be redirected directly into the dashboard."}
                            </p>

                            {oidcConfigured ? (
                                <form action={signInWithOidc}>
                                    <Button
                                        type="submit"
                                        size="lg"
                                        className="h-12 w-full justify-between rounded-2xl px-5 text-sm font-semibold shadow-lg shadow-slate-950/10"
                                    >
                                        <span className="flex items-center gap-3">
                                            <span className="bg-background/20 flex h-8 w-8 items-center justify-center rounded-xl">
                                                <KeyRound className="h-4 w-4" />
                                            </span>
                                            Continue with {oidcName}
                                        </span>
                                        <ArrowRight className="h-4 w-4" />
                                    </Button>
                                </form>
                            ) : (
                                <form action={signInWithDiscord}>
                                    <Button
                                        type="submit"
                                        size="lg"
                                        className="h-12 w-full justify-between rounded-2xl px-5 text-sm font-semibold shadow-lg shadow-slate-950/10"
                                    >
                                        <span className="flex items-center gap-3">
                                            <span className="bg-background/20 flex h-8 w-8 items-center justify-center rounded-xl">
                                                <svg
                                                    aria-hidden="true"
                                                    viewBox="0 0 24 24"
                                                    className="h-4 w-4 fill-current"
                                                >
                                                    <path d="M20.317 4.369A19.791 19.791 0 0 0 15.558 3c-.206.375-.444.88-.608 1.275a18.27 18.27 0 0 0-5.9 0A12.6 12.6 0 0 0 8.442 3a19.736 19.736 0 0 0-4.76 1.369C.676 8.875-.142 13.27.267 17.602A19.94 19.94 0 0 0 6.13 20.67c.472-.645.892-1.327 1.255-2.043-.688-.26-1.344-.58-1.964-.95.164-.12.325-.245.48-.375 3.788 1.775 7.904 1.775 11.648 0 .158.13.32.255.48.375-.62.372-1.278.69-1.967.95.364.716.784 1.398 1.255 2.043a19.904 19.904 0 0 0 5.864-3.069c.48-5.025-.82-9.38-2.864-13.233ZM8.02 14.928c-1.14 0-2.074-1.046-2.074-2.33 0-1.285.915-2.331 2.074-2.331 1.168 0 2.093 1.055 2.074 2.33 0 1.285-.916 2.331-2.074 2.331Zm7.958 0c-1.14 0-2.073-1.046-2.073-2.33 0-1.285.915-2.331 2.073-2.331 1.169 0 2.094 1.055 2.074 2.33 0 1.285-.905 2.331-2.074 2.331Z" />
                                                </svg>
                                            </span>
                                            Continue with Discord
                                        </span>
                                        <ArrowRight className="h-4 w-4" />
                                    </Button>
                                </form>
                            )}

                            {githubAuthConfigured ? (
                                <p className="text-muted-foreground border-border/70 flex items-start gap-2.5 border-t pt-4 text-xs leading-5">
                                    <Github className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    <span>
                                        GitHub is not a login method. Sign in
                                        above, then connect GitHub from{" "}
                                        <strong className="text-foreground font-medium">
                                            Account
                                        </strong>{" "}
                                        to unlock the Free Proxy Pool rewards.
                                    </span>
                                </p>
                            ) : null}
                        </div>

                        <div className="text-muted-foreground mt-6 grid gap-3 text-sm sm:grid-cols-2">
                            <div className="border-border/70 bg-background/55 rounded-2xl border p-4">
                                <p className="text-foreground font-medium">
                                    Account linking
                                </p>
                                <p className="mt-1 leading-6">
                                    {oidcConfigured
                                        ? `Authentication runs through ${oidcName} and returns you to the app automatically.`
                                        : "Authentication runs through Discord and returns you to the app automatically."}
                                </p>
                            </div>
                            <div className="border-border/70 bg-background/55 rounded-2xl border p-4">
                                <p className="text-foreground font-medium">
                                    Single provider
                                </p>
                                <p className="mt-1 leading-6">
                                    {oidcConfigured
                                        ? `Discord is disabled while ${oidcName} is configured.`
                                        : "Discord is the only sign-in method; GitHub is connected later from Account."}
                                </p>
                            </div>
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
}
