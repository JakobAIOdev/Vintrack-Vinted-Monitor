import { auth } from "@/auth";
import { redirect } from "next/navigation";
import type { AccountStatus } from "./client";
import { AccountClient } from "./client";
import { getAccountStatus } from "@/actions/account";
import { getMemberGithubRewardStatus } from "@/lib/github-rewards.server";
import { GithubRewardStatusCard } from "@/components/github-reward-status-card";
import { CircleUserRound, ShoppingBag } from "lucide-react";

export default async function AccountPage({
    searchParams,
}: {
    searchParams?: Promise<{ github?: string }>;
}) {
    const session = await auth();
    if (!session?.user) redirect("/login");

    const [status, githubRewards] = await Promise.all([
        getAccountStatus(),
        getMemberGithubRewardStatus(session.user.id),
    ]);
    const githubResult = (await searchParams)?.github;
    const latestExtensionVersion =
        process.env.BROWSER_EXTENSION_LATEST_VERSION?.trim() || "0.1.5";
    const minimumExtensionVersion =
        process.env.BROWSER_EXTENSION_MIN_VERSION?.trim() ||
        latestExtensionVersion;
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

            <div className="grid items-start gap-5 xl:grid-cols-[minmax(340px,0.78fr)_minmax(0,1.62fr)]">
                <aside className="xl:sticky xl:top-5">
                    <GithubRewardStatusCard
                        status={githubRewards}
                        placement="account"
                        showUpgradeConfirmation={
                            githubResult === "connected" &&
                            githubRewards.starred
                        }
                    />
                </aside>

                <section className="min-w-0 space-y-3">
                    <div className="flex items-center gap-3 px-0.5 py-0.5">
                        <div className="border-border/70 bg-muted/40 flex h-9 w-9 items-center justify-center rounded-lg border">
                            <ShoppingBag className="h-4 w-4" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold">
                                Vinted connection
                            </h2>
                            <p className="text-muted-foreground text-xs">
                                Session health, browser sync and checkout data
                            </p>
                        </div>
                    </div>
                    <AccountClient
                        initialStatus={status as AccountStatus}
                        latestExtensionVersion={latestExtensionVersion}
                        minimumExtensionVersion={minimumExtensionVersion}
                        firefoxExtensionUrl={firefoxExtensionUrl}
                    />
                </section>
            </div>
        </div>
    );
}
