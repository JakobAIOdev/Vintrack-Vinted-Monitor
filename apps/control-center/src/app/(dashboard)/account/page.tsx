import { GuideHelpLink } from "@/components/guides/guide-help-link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import type { AccountStatus } from "./client";
import { AccountClient } from "./client";
import { getAccountStatus } from "@/actions/account";
import { getMemberGithubRewardStatus } from "@/lib/github-rewards.server";
import { GithubRewardStatusCard } from "@/components/github-reward-status-card";
import { AccountConnectionTabs } from "@/components/account/account-connection-tabs";
import { CheckoutFeatureShortcut } from "@/components/account/checkout-feature-shortcut";
import { checkoutFeatureDiscoverable } from "@/lib/account-updates";
import { getFeatureAccessForUser } from "@/lib/features.server";
import { db } from "@/lib/db";

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

    const [status, githubRewards, checkoutAccess] = await Promise.all([
        getAccountStatus(),
        getMemberGithubRewardStatus(session.user.id),
        getFeatureAccessForUser("checkout_links", session.user.id, db, false),
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
        process.env.BROWSER_EXTENSION_LATEST_VERSION?.trim() || "0.4.3";
    const minimumExtensionVersion =
        process.env.BROWSER_EXTENSION_MIN_VERSION?.trim() || "0.2.1";
    const firefoxExtensionUrl =
        process.env.BROWSER_EXTENSION_FIREFOX_URL?.trim() ||
        "https://addons.mozilla.org/firefox/addon/vintrack-browser-sync/";

    return (
        <div className="mx-auto max-w-5xl space-y-5">
            <header>
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                        Account &amp; connections
                    </h1>
                    <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                        Manage login providers, rewards, and the Vinted session
                        used by member tools.
                    </p>
                    <GuideHelpLink href="/guide/account#link-account">
                        Account linking guide
                    </GuideHelpLink>
                    {checkoutFeatureDiscoverable(checkoutAccess) && (
                        <CheckoutFeatureShortcut linked={status.linked} />
                    )}
                </div>
            </header>

            <AccountConnectionTabs
                active={activeConnection}
                vintedLinked={status.linked}
                githubConnected={githubRewards.githubConnected}
            />

            <section
                key={activeConnection}
                id={`${activeConnection}-connection`}
                className="account-connection-panel min-w-0 scroll-mt-20 space-y-3"
            >
                <div>
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
