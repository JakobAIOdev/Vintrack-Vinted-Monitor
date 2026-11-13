import { auth, githubAuthConfigured, signIn } from "@/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
    ArrowRight,
    Bell,
    Github,
    KeyRound,
    ShieldCheck,
    Zap,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { oidcConfigured, oidcName } from "@/lib/auth-provider";
import { checkoutReturnPath } from "@/lib/checkout";

export const metadata: Metadata = {
    title: "Login | Vintrack",
    description: "Sign in to access the Vintrack dashboard.",
    robots: {
        index: false,
        follow: false,
    },
};

async function signInWithDiscord(returnTo: string) {
    "use server";

    await signIn("discord", { redirectTo: checkoutReturnPath(returnTo) });
}

async function signInWithOidc(returnTo: string) {
    "use server";

    await signIn("oidc", { redirectTo: checkoutReturnPath(returnTo) });
}

const highlights = [
    {
        icon: Zap,
        title: "Live monitors",
        copy: "New listings from your active searches, as they appear",
    },
    {
        icon: Bell,
        title: "Alerts where you read them",
        copy: "Discord, Telegram and the live feed, per monitor",
    },
    {
        icon: ShieldCheck,
        title: "Protected dashboard",
        copy: "Every dashboard page requires a signed-in session",
    },
];

export default async function LoginPage({
    searchParams,
}: {
    searchParams?: Promise<{ error?: string; returnTo?: string | string[] }>;
}) {
    const session = await auth();
    const query = await searchParams;
    const error = query?.error;
    const returnTo = checkoutReturnPath(query?.returnTo);

    if (session?.user && error) {
        redirect(
            `/account?connection=github&github=error&reason=${encodeURIComponent(error)}`,
        );
    }
    if (session?.user) {
        redirect(returnTo);
    }

    return (
        <div className="bg-background text-foreground relative min-h-screen overflow-hidden">
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

            <main className="mx-auto grid min-h-[calc(100vh-88px)] w-full max-w-7xl items-center gap-10 px-6 pb-10 sm:px-8 lg:grid-cols-[1.15fr_0.85fr]">
                <section className="max-w-2xl space-y-8 py-8 lg:py-16">
                    <div className="space-y-5">
                        <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                            Sign in to your Vinted monitors
                        </h1>
                        <p className="text-muted-foreground max-w-xl text-base leading-8 sm:text-lg">
                            {oidcConfigured
                                ? `Sign in with ${oidcName} to open your monitors, live feed, chats, likes, proxies and account tools`
                                : "Sign in with Discord to open your monitors, live feed, chats, likes, proxies and account tools"}
                        </p>
                    </div>

                    <ul className="border-border/70 divide-border/70 max-w-xl divide-y border-y">
                        {highlights.map((item) => (
                            <li
                                key={item.title}
                                className="flex items-start gap-3 py-4"
                            >
                                <item.icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                                <div>
                                    <h2 className="text-foreground text-sm font-medium">
                                        {item.title}
                                    </h2>
                                    <p className="text-muted-foreground mt-1 text-sm leading-6">
                                        {item.copy}
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>

                <section className="relative">
                    <div className="border-border/70 bg-card relative overflow-hidden rounded-2xl border p-6 sm:p-8">
                        <h2 className="mb-6 text-2xl font-semibold tracking-tight">
                            Sign in
                        </h2>

                        <div className="border-border/70 bg-background/70 space-y-4 rounded-xl border p-4">
                            {error ? (
                                <div
                                    role="alert"
                                    className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-700 dark:text-red-300"
                                >
                                    {error === "AccessDenied"
                                        ? "This account is not allowed to access this instance. Contact the instance administrator."
                                        : error === "OAuthAccountNotLinked"
                                          ? "That GitHub account cannot be used to sign in. Sign in with your usual provider below, then connect GitHub from Account. Accounts are never merged by email automatically."
                                          : "Authentication could not be completed. Please try again or use your existing login provider."}
                                </div>
                            ) : null}
                            <p className="text-muted-foreground text-sm leading-7">
                                {oidcConfigured
                                    ? `Use your ${oidcName} account to authenticate. You return to the dashboard right after.`
                                    : "Use your Discord account to authenticate. You return to the dashboard right after."}
                            </p>

                            {oidcConfigured ? (
                                <form
                                    action={signInWithOidc.bind(null, returnTo)}
                                >
                                    <Button
                                        type="submit"
                                        size="lg"
                                        className="h-11 w-full justify-between rounded-lg px-4 text-sm font-medium"
                                    >
                                        <span className="flex items-center gap-3">
                                            <span className="bg-background/20 flex h-7 w-7 items-center justify-center rounded-md">
                                                <KeyRound className="h-4 w-4" />
                                            </span>
                                            Continue with {oidcName}
                                        </span>
                                        <ArrowRight className="h-4 w-4" />
                                    </Button>
                                </form>
                            ) : (
                                <form
                                    action={signInWithDiscord.bind(
                                        null,
                                        returnTo,
                                    )}
                                >
                                    <Button
                                        type="submit"
                                        size="lg"
                                        className="h-11 w-full justify-between rounded-lg px-4 text-sm font-medium"
                                    >
                                        <span className="flex items-center gap-3">
                                            <span className="bg-background/20 flex h-7 w-7 items-center justify-center rounded-md">
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

                        <div className="text-muted-foreground mt-6 grid gap-6 text-sm sm:grid-cols-2">
                            <div>
                                <p className="text-foreground font-medium">
                                    Account linking
                                </p>
                                <p className="mt-1 leading-6">
                                    {oidcConfigured
                                        ? `Authentication runs through ${oidcName} and returns you to the app automatically.`
                                        : "Authentication runs through Discord and returns you to the app automatically."}
                                </p>
                            </div>
                            <div>
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
