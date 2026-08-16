"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
    Check,
    CircleCheck,
    ExternalLink,
    Github,
    Heart,
    Infinity as InfinityIcon,
    LoaderCircle,
    ShieldCheck,
    Sparkles,
    Star,
    Unlink,
    X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
    connectGithubAccount,
    disconnectGithubAccount,
    recheckGithubRewards,
    recordRewardPrompt,
    resumeFreeProxyMonitorsAfterUpgrade,
} from "@/actions/github-rewards";
import type { MemberGithubRewardStatus } from "@/lib/github-rewards.server";

function sourceLabel(source: MemberGithubRewardStatus["source"]) {
    switch (source) {
        case "donation":
            return "Supporter";
        case "github_star":
            return "GitHub Star";
        case "policy_default":
            return "Default";
        case "role_exempt":
            return "Unlimited";
        default:
            return source ? "Admin override" : "Legacy policy";
    }
}

function sourceDescription(source: MemberGithubRewardStatus["source"]) {
    switch (source) {
        case "donation":
            return "Lifetime supporter access";
        case "github_star":
            return "Verified repository star";
        case "role_exempt":
            return "Your role is exempt from this policy";
        case "user_override":
            return "Limit set by an administrator";
        default:
            return "Standard member allowance";
    }
}

export function GithubRewardStatusCard({
    status,
    placement,
    showPrompt = false,
    pausedMonitors = [],
    showUpgradeConfirmation = false,
    showAnnouncement = false,
}: {
    status: MemberGithubRewardStatus;
    placement: "account" | "dashboard";
    showPrompt?: boolean;
    pausedMonitors?: { id: number; name: string }[];
    showUpgradeConfirmation?: boolean;
    showAnnouncement?: boolean;
}) {
    const router = useRouter();
    const [visible, setVisible] = useState(true);
    const [pending, startTransition] = useTransition();
    const prompt = status.prompt;

    useEffect(() => {
        if (showPrompt && prompt) {
            void recordRewardPrompt(prompt.type, "shown");
        } else if (showAnnouncement) {
            void recordRewardPrompt("announcement", "shown");
        }
    }, [prompt, showAnnouncement, showPrompt]);

    useEffect(() => {
        if (!showUpgradeConfirmation) return;
        // Clear only the one-shot `github` flag; other query params on the page
        // must survive.
        const params = new URLSearchParams(window.location.search);
        params.delete("github");
        const query = params.toString();
        router.replace(`/account${query ? `?${query}` : ""}`, {
            scroll: false,
        });
    }, [router, showUpgradeConfirmation]);

    const repositoryUrl = `https://github.com/${status.policy.repositoryOwner}/${status.policy.repositoryName}`;
    const sponsorsUrl = `https://github.com/sponsors/${status.policy.sponsorsLogin}`;
    const effectiveLimit = status.effectiveLimit;
    const usageLabel = `${status.freeProxyActiveCount}/${effectiveLimit ?? "∞"}`;
    const usagePercent = effectiveLimit
        ? Math.min(100, (status.freeProxyActiveCount / effectiveLimit) * 100)
        : 0;
    const tierLabel = status.policy.enforcementEnabled
        ? sourceLabel(status.source)
        : "Not enforced";
    const tierDescription = status.policy.enforcementEnabled
        ? sourceDescription(status.source)
        : "Rewards are ready; limits are still in preview mode";
    const remainingSlots =
        effectiveLimit === null
            ? null
            : Math.max(0, effectiveLimit - status.freeProxyActiveCount);
    const suppressRewardCta =
        placement === "dashboard" && status.source === "user_override";
    const githubReady = status.githubConnected || status.githubIdentityKnown;

    const trackCta = () => {
        if (prompt) void recordRewardPrompt(prompt.type, "cta");
    };
    const disconnect = () => {
        startTransition(async () => {
            try {
                await disconnectGithubAccount();
                toast.success("GitHub disconnected");
                router.refresh();
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : "Could not disconnect GitHub",
                );
            }
        });
    };
    const recheck = () => {
        startTransition(async () => {
            const result = await recheckGithubRewards();
            if (!result.ok) {
                toast.error(result.error);
                return;
            }
            if (!result.starred) {
                toast.error(
                    "No star found yet. Make sure you starred Vintrack with the linked GitHub account, then try again.",
                );
                return;
            }
            if (result.limitSource === "user_override") {
                toast.success(
                    `GitHub star verified. Your administrator-set Free Pool limit remains ${result.effectiveLimit}.`,
                );
            } else if (result.effectiveLimit === null) {
                toast.success(
                    "GitHub star verified. Your current role already has unlimited Free Pool access.",
                );
            } else if (result.resumableCount > 0) {
                toast.success(
                    `GitHub star verified — your Free Pool limit is now ${result.effectiveLimit}.`,
                    {
                        duration: 10_000,
                        action: {
                            label: `Start ${result.resumableCount} monitor${result.resumableCount === 1 ? "" : "s"}`,
                            onClick: () => void resume(),
                        },
                    },
                );
            } else {
                toast.success(
                    `GitHub star verified — your Free Pool limit is now ${result.effectiveLimit}.`,
                );
            }
            router.refresh();
        });
    };
    const resume = async () => {
        try {
            const { startedCount } = await resumeFreeProxyMonitorsAfterUpgrade();
            toast.success(
                startedCount === 0
                    ? "No paused Free Pool monitors to start."
                    : `Started ${startedCount} monitor${startedCount === 1 ? "" : "s"}.`,
            );
            router.refresh();
        } catch {
            toast.error("Could not start your paused monitors.");
        }
    };

    const actions = (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {suppressRewardCta ? (
                <span className="text-muted-foreground text-sm">
                    Contact an administrator to change this limit.
                </span>
            ) : !githubReady ? (
                <form action={connectGithubAccount} onSubmit={trackCta}>
                    <Button type="submit" disabled={pending} className="w-full">
                        <Github className="h-4 w-4" />
                        Connect GitHub
                    </Button>
                </form>
            ) : !status.starred ? (
                <>
                    <Button asChild onClick={trackCta}>
                        <a
                            href={repositoryUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <Star className="h-4 w-4" />
                            Star Vintrack
                            <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                        </a>
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={pending}
                        onClick={recheck}
                    >
                        {pending ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : null}
                        {pending ? "Checking GitHub…" : "Check again"}
                    </Button>
                </>
            ) : !status.donated ? (
                <Button asChild onClick={trackCta}>
                    <a href={sponsorsUrl} target="_blank" rel="noreferrer">
                        <Heart className="h-4 w-4" />
                        Support Vintrack
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                    </a>
                </Button>
            ) : (
                <span className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <ShieldCheck className="h-4 w-4" />
                    Lifetime supporter limit active
                </span>
            )}
        </div>
    );

    if (placement === "dashboard" && !status.policy.enforcementEnabled) {
        return null;
    }
    if (
        placement === "dashboard" &&
        status.source === "role_exempt" &&
        !showAnnouncement
    ) {
        return null;
    }
    if (
        placement === "dashboard" &&
        !showPrompt &&
        !showAnnouncement &&
        pausedMonitors.length === 0
    ) {
        return null;
    }

    if (placement === "account") {
        const rewardSteps = [
            {
                label: "Member",
                detail: "Included by default",
                limit: status.policy.defaultLimit,
                icon: ShieldCheck,
                achieved: true,
                active: status.source === "policy_default",
            },
            {
                label: "GitHub Star",
                detail: status.starred
                    ? "Star verified"
                    : "Star the repository",
                limit: status.policy.starLimit,
                icon: Star,
                achieved: status.starred,
                active: status.source === "github_star",
            },
            {
                label: "Supporter",
                detail: status.donated ? "Lifetime unlock" : "Any donation",
                limit: status.policy.donationLimit,
                icon: Heart,
                achieved: status.donated,
                active: status.source === "donation",
            },
        ];

        return (
            <Card
                className="border-border/70 overflow-hidden py-0 shadow-sm"
                data-testid="github-reward-status"
            >
                <div className="relative overflow-hidden border-b bg-[linear-gradient(145deg,var(--card),color-mix(in_oklab,var(--muted)_72%,var(--card)))] p-5">
                    <div className="bg-foreground/5 absolute -top-16 -right-16 h-44 w-44 rounded-full blur-2xl" />
                    <div className="relative">
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-3">
                                <div className="bg-foreground text-background flex h-9 w-9 items-center justify-center rounded-lg shadow-sm">
                                    <Github className="h-4.5 w-4.5" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold">
                                        GitHub Rewards
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        {tierDescription}
                                    </p>
                                </div>
                            </div>
                            <Badge
                                variant={
                                    status.donated ? "default" : "secondary"
                                }
                                className="rounded-full"
                            >
                                {tierLabel}
                            </Badge>
                        </div>

                        <div className="mt-6 flex items-end justify-between gap-4">
                            <div>
                                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                                    Free Pool usage
                                </p>
                                <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                                    {usageLabel}
                                </p>
                            </div>
                            <div className="text-muted-foreground pb-1 text-right text-xs">
                                {effectiveLimit === null ? (
                                    <span className="inline-flex items-center gap-1.5">
                                        <InfinityIcon className="h-4 w-4" />{" "}
                                        Unlimited
                                    </span>
                                ) : (
                                    <>
                                        <p>{remainingSlots} slots available</p>
                                        <p className="mt-0.5">
                                            Running monitors
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>
                        {effectiveLimit !== null ? (
                            <div className="bg-foreground/10 mt-4 h-1.5 overflow-hidden rounded-full">
                                <div
                                    className={cn(
                                        "h-full rounded-full transition-[width] duration-500",
                                        status.limitReached
                                            ? "bg-amber-500"
                                            : "bg-foreground",
                                    )}
                                    style={{ width: `${usagePercent}%` }}
                                />
                            </div>
                        ) : null}
                    </div>
                </div>

                <CardContent className="space-y-4 p-5">
                    {showUpgradeConfirmation ? (
                        <div className="flex gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3.5 text-sm">
                            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                            <div>
                                <p className="font-semibold">
                                    Limit increased to {status.policy.starLimit}
                                </p>
                                <p className="text-muted-foreground mt-0.5 text-xs leading-5">
                                    Your GitHub star was verified successfully.
                                </p>
                            </div>
                        </div>
                    ) : null}

                    <div>
                        <div className="mb-2.5 flex items-center justify-between">
                            <p className="text-xs font-semibold tracking-wide uppercase">
                                Reward levels
                            </p>
                            <Sparkles className="text-muted-foreground h-4 w-4" />
                        </div>
                        <div className="space-y-2">
                            {rewardSteps.map((step) => {
                                const Icon = step.icon;
                                return (
                                    <div
                                        key={step.label}
                                        className={cn(
                                            "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                                            step.active
                                                ? "border-foreground/20 bg-foreground/[0.04]"
                                                : "border-border/60 bg-background/50",
                                        )}
                                    >
                                        <div
                                            className={cn(
                                                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                                                step.achieved
                                                    ? "bg-foreground text-background"
                                                    : "bg-muted text-muted-foreground",
                                            )}
                                        >
                                            {step.achieved ? (
                                                <Check className="h-4 w-4" />
                                            ) : (
                                                <Icon className="h-4 w-4" />
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-medium">
                                                {step.label}
                                            </p>
                                            <p className="text-muted-foreground truncate text-xs">
                                                {step.detail}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-semibold tabular-nums">
                                                {step.limit}
                                            </p>
                                            <p className="text-muted-foreground text-[10px] uppercase">
                                                monitors
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="border-border/60 bg-muted/25 rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                                    Connected identity
                                </p>
                                <p className="mt-1 truncate text-sm font-medium">
                                    {status.githubConnected
                                        ? `@${status.githubLogin ?? "github"}`
                                        : "No GitHub account"}
                                </p>
                            </div>
                            <div className="text-right">
                                <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                                    Login providers
                                </p>
                                <p className="mt-1 text-sm font-medium capitalize">
                                    {status.loginProviders.join(" · ") ||
                                        "None"}
                                </p>
                            </div>
                        </div>
                        {status.starVerifiedAt ? (
                            <p className="text-muted-foreground mt-2 border-t pt-2 text-[11px]">
                                Star checked{" "}
                                {new Date(
                                    status.starVerifiedAt,
                                ).toLocaleString()}
                            </p>
                        ) : null}
                    </div>

                    {actions}

                    {status.githubConnected ? (
                        <div className="border-border/60 flex items-center justify-between gap-3 border-t pt-3.5">
                            <p className="text-muted-foreground text-xs leading-5">
                                Your GitHub identity stays tied to this account:
                                rewards you already earned remain active and
                                cannot be moved to another member.
                            </p>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={disconnect}
                                disabled={pending}
                                className="shrink-0 text-xs"
                            >
                                <Unlink className="h-3.5 w-3.5" />
                                Disconnect
                            </Button>
                        </div>
                    ) : null}
                </CardContent>
            </Card>
        );
    }

    if (!visible) return null;

    const dashboardTitle = showAnnouncement
        ? status.policy.announcementTitle
        : pausedMonitors.length > 0 && !prompt
          ? "Free Pool limit applied"
          : (prompt?.title ?? "Free Pool update");
    const dashboardMessage = showAnnouncement
        ? status.policy.announcementMessage
        : (prompt?.message ??
          `${tierLabel} · ${remainingSlots ?? "Unlimited"} Free Pool slots available.`);

    return (
        <Card
            className={cn(
                "border-border/80 bg-card/95 fixed right-3 bottom-3 left-3 z-40 overflow-hidden py-0 shadow-xl backdrop-blur sm:right-5 sm:bottom-5 sm:left-auto sm:w-full sm:max-w-md",
                status.limitReached && "border-amber-500/35",
            )}
            data-testid="github-reward-status"
        >
            <div className="p-4">
                <div className="flex min-w-0 items-start gap-3 pr-8">
                    <div
                        className={cn(
                            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                            status.limitReached
                                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                : "bg-muted text-foreground",
                        )}
                    >
                        <Github className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold">
                                {dashboardTitle}
                            </p>
                            <Badge
                                variant="outline"
                                className="rounded-full text-[10px]"
                            >
                                {usageLabel}
                            </Badge>
                        </div>
                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                            {dashboardMessage}
                        </p>
                    </div>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                        setVisible(false);
                        if (showPrompt && prompt) {
                            void recordRewardPrompt(prompt.type, "dismissed");
                        } else if (showAnnouncement) {
                            void recordRewardPrompt(
                                "announcement",
                                "dismissed",
                            );
                        }
                    }}
                    className="text-muted-foreground absolute top-2.5 right-2.5 rounded-full"
                    aria-label="Dismiss Free Pool message"
                >
                    <X className="h-3.5 w-3.5" />
                </Button>
            </div>
            <CardContent className="space-y-3 border-t px-4 py-3">
                {pausedMonitors.length > 0 ? (
                    <p className="text-muted-foreground text-xs leading-5">
                        Paused:{" "}
                        {pausedMonitors.map((monitor, index) => (
                            <span key={monitor.id}>
                                {index > 0 ? ", " : ""}
                                <a
                                    className="text-foreground font-medium underline underline-offset-2"
                                    href={`/monitors/${monitor.id}`}
                                >
                                    {monitor.name}
                                </a>
                            </span>
                        ))}
                    </p>
                ) : null}
                {actions}
            </CardContent>
        </Card>
    );
}
