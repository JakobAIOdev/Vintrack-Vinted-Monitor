import { auth } from "@/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { AccountStatus } from "./client";
import { AccountClient } from "./client";
import { getAccountStatus } from "@/actions/account";
import { getMemberGithubRewardStatus } from "@/lib/github-rewards.server";
import { GithubRewardStatusCard } from "@/components/github-reward-status-card";
import { CircleUserRound, Github, ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils";

function githubConnectionErrorMessage(reason?: string) {
    switch (reason) {
        case "claim_conflict":
        case "account_conflict":
        case "OAuthAccountNotLinked":
            return "This GitHub account is already connected to another Vintrack account. Disconnect it there first, then try again.";
        case "session_missing":
            return "Your Vintrack session could not be verified for this connection. Reload this page, sign in again if needed, and retry.";
        default:
            return "GitHub could not complete the connection. Your Vintrack session is still active; please try again.";
    }
}

export default async function AccountPage({
    searchParams,
}: {
    searchParams?: Promise<{
        github?: string;
        connection?: string;
        reason?: string;
    }>;
}) {
    const session = await auth();
    if (!session?.user) redirect("/login");

    const [status, githubRewards] = await Promise.all([
        getAccountStatus(),
        getMemberGithubRewardStatus(session.user.id),
    ]);
    const resolvedSearchParams = await searchParams;
    const githubResult = resolvedSearchParams?.github;
    const githubErrorReason = resolvedSearchParams?.reason;
    const activeConnection =
        resolvedSearchParams?.connection === "github" ||
        githubResult === "connected" ||
        githubResult === "error"
            ? "github"
            : "vinted";
    const latestExtensionVersion =
        process.env.BROWSER_EXTENSION_LATEST_VERSION?.trim() || "0.2";
    const minimumExtensionVersion =
        process.env.BROWSER_EXTENSION_MIN_VERSION?.trim() || "0.1.5";
    const firefoxExtensionUrl =
        process.env.BROWSER_EXTENSION_FIREFOX_URL?.trim() ||
        "https://addons.mozilla.org/firefox/addon/vintrack-browser-sync/";

    return (
        <div className="mx-auto max-w-[1440px] space-y-5">
            <header className="border-border/60 flex items-start gap-3 border-b pb-5">
                <div className="border-border/70 bg-muted/40 mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
                    <CircleUserRound className="h-5 w-5" />
                </div>
                <div>
                    <p className="text-muted-foreground text-xs font-medium tracking-[0.18em] uppercase">
                        Settings
                    </p>
                    <h1 className="mt-0.5 text-2xl font-semibold tracking-tight sm:text-3xl">
                        Account &amp; connections
                    </h1>
                    <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-6">
                        Manage login providers, rewards, and the Vinted session
                        used by member tools.
                    </p>
                </div>
            </header>

            <nav
                aria-label="Account connections"
                className="grid gap-3 sm:grid-cols-2"
            >
                {[
                    {
                        id: "github",
                        label: "GitHub Rewards",
                        description: "Identity, stars and Free Pool rewards",
                        status: githubRewards.githubConnected
                            ? "Connected"
                            : "Not connected",
                        icon: Github,
                    },
                    {
                        id: "vinted",
                        label: "Vinted",
                        description: "Session, browser sync and account tools",
                        status: status.linked ? "Linked" : "Not linked",
                        icon: ShoppingBag,
                    },
                ].map((connection) => {
                    const Icon = connection.icon;
                    const selected = activeConnection === connection.id;
                    return (
                        <Link
                            key={connection.id}
                            href={`/account?connection=${connection.id}`}
                            aria-current={selected ? "page" : undefined}
                            className={cn(
                                "group border-border/70 bg-card flex items-center gap-3 rounded-2xl border p-4 shadow-sm transition-all",
                                "hover:border-foreground/20 hover:-translate-y-0.5 hover:shadow-md",
                                selected &&
                                    "border-foreground/20 bg-foreground/[0.035] ring-foreground/8 ring-1",
                            )}
                        >
                            <span
                                className={cn(
                                    "bg-muted text-muted-foreground flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors",
                                    selected &&
                                        "bg-foreground text-background shadow-sm",
                                )}
                            >
                                <Icon className="h-5 w-5" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center justify-between gap-3">
                                    <span className="font-semibold">
                                        {connection.label}
                                    </span>
                                    <span
                                        className={cn(
                                            "text-muted-foreground rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                                            selected &&
                                                "border-foreground/15 text-foreground",
                                        )}
                                    >
                                        {connection.status}
                                    </span>
                                </span>
                                <span className="text-muted-foreground mt-1 block text-xs">
                                    {connection.description}
                                </span>
                            </span>
                        </Link>
                    );
                })}
            </nav>

            <section className="min-w-0 space-y-3">
                <div className="flex items-center gap-3 px-0.5 py-0.5">
                    <div className="border-border/70 bg-muted/40 flex h-9 w-9 items-center justify-center rounded-lg border">
                        {activeConnection === "github" ? (
                            <Github className="h-4 w-4" />
                        ) : (
                            <ShoppingBag className="h-4 w-4" />
                        )}
                    </div>
                    <div>
                        <h2 className="text-base font-semibold">
                            {activeConnection === "github"
                                ? "GitHub rewards"
                                : "Vinted connection"}
                        </h2>
                        <p className="text-muted-foreground text-xs">
                            {activeConnection === "github"
                                ? "Reward identity and Free Proxy Pool allowance"
                                : "Session health, browser sync and account tools"}
                        </p>
                    </div>
                </div>

                {activeConnection === "github" ? (
                    <div className="space-y-3">
                        {githubResult === "error" ? (
                            <div
                                role="alert"
                                className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300"
                            >
                                {githubConnectionErrorMessage(
                                    githubErrorReason,
                                )}
                            </div>
                        ) : githubResult === "connected" &&
                          !githubRewards.githubConnected ? (
                            <div
                                role="alert"
                                className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
                            >
                                GitHub returned successfully, but the provider
                                link was not saved. Try connecting once more.
                            </div>
                        ) : null}
                        <GithubRewardStatusCard
                            status={githubRewards}
                            placement="account"
                            showUpgradeConfirmation={
                                githubResult === "connected" &&
                                githubRewards.starred
                            }
                        />
                    </div>
                ) : (
                    <AccountClient
                        initialStatus={status as AccountStatus}
                        latestExtensionVersion={latestExtensionVersion}
                        minimumExtensionVersion={minimumExtensionVersion}
                        firefoxExtensionUrl={firefoxExtensionUrl}
                    />
                )}
            </section>
        </div>
    );
}
