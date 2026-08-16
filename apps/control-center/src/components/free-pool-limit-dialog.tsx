"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    ArrowRight,
    Check,
    ExternalLink,
    Github,
    Heart,
    LoaderCircle,
    ShieldCheck,
    Star,
} from "lucide-react";
import { toast } from "sonner";
import {
    connectGithubAccount,
    recheckGithubRewards,
    resumeFreeProxyMonitorsAfterUpgrade,
} from "@/actions/github-rewards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { MonitorActivationBlock } from "@/lib/monitor-limits";

export function FreePoolLimitDialog({
    block,
    onOpenChange,
}: {
    block: MonitorActivationBlock | null;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [checking, startChecking] = useTransition();
    const usage = block?.freePool;
    if (!block || block.code !== "free_proxy_limit" || !usage) return null;

    const hasAdminLimit = usage.source === "user_override";
    const githubReady = usage.githubConnected || usage.githubIdentityKnown;
    const tiers = [
        {
            key: "policy_default",
            label: "Default",
            detail: "Included",
            limit: usage.defaultLimit,
            icon: ShieldCheck,
        },
        {
            key: "github_star",
            label: "GitHub Star",
            detail: "Star the project",
            limit: usage.starLimit,
            icon: Star,
        },
        {
            key: "donation",
            label: "Supporter",
            detail: "Any donation",
            limit: usage.donationLimit,
            icon: Heart,
        },
    ];
    const activeTierIndex =
        usage.source === "donation"
            ? 2
            : usage.source === "github_star"
              ? 1
              : 0;
    const checkAgain = () => {
        startChecking(async () => {
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
            onOpenChange(false);
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

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
                <div className="border-border/70 bg-muted/25 border-b px-5 py-5 sm:px-6">
                    <DialogHeader className="gap-2 text-left">
                        <div className="flex items-center gap-2">
                            <Badge
                                variant="outline"
                                className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            >
                                {usage.activeCount}/{usage.limit} active
                            </Badge>
                            <span className="text-muted-foreground text-xs">
                                Free Proxy Pool
                            </span>
                        </div>
                        <DialogTitle className="text-xl">
                            {block.title}
                        </DialogTitle>
                        <DialogDescription className="max-w-lg leading-6">
                            This monitor stayed paused. Choose how you want to
                            create more capacity.
                        </DialogDescription>
                    </DialogHeader>
                </div>

                <div className="space-y-5 px-5 py-5 sm:px-6">
                    {hasAdminLimit ? (
                        <div className="border-border/70 bg-muted/25 rounded-lg border p-4">
                            <p className="text-sm font-semibold">
                                Administrative limit: {usage.limit}
                            </p>
                            <p className="text-muted-foreground mt-1 text-sm leading-6">
                                This member-specific limit overrides GitHub
                                rewards. Contact an administrator to change it.
                            </p>
                        </div>
                    ) : (
                        <div>
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <p className="text-sm font-semibold">
                                    Increase your Free Pool limit
                                </p>
                                <span className="text-muted-foreground text-xs">
                                    Permanent supporter unlock
                                </span>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-3">
                                {tiers.map((tier, index) => {
                                    const Icon = tier.icon;
                                    const achieved = index <= activeTierIndex;
                                    const current = index === activeTierIndex;
                                    return (
                                        <div
                                            key={tier.key}
                                            className={cn(
                                                "border-border/70 relative rounded-lg border p-3.5",
                                                current &&
                                                    "border-foreground/25 bg-foreground/[0.035]",
                                            )}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div
                                                    className={cn(
                                                        "bg-muted text-muted-foreground flex h-7 w-7 items-center justify-center rounded-md",
                                                        achieved &&
                                                            "bg-foreground text-background",
                                                    )}
                                                >
                                                    {achieved ? (
                                                        <Check className="h-3.5 w-3.5" />
                                                    ) : (
                                                        <Icon className="h-3.5 w-3.5" />
                                                    )}
                                                </div>
                                                {current ? (
                                                    <Badge
                                                        variant="secondary"
                                                        className="text-[9px] uppercase"
                                                    >
                                                        Current
                                                    </Badge>
                                                ) : null}
                                            </div>
                                            <p className="mt-3 text-sm font-semibold">
                                                {tier.label}
                                            </p>
                                            <p className="text-muted-foreground mt-0.5 text-[11px]">
                                                {tier.detail}
                                            </p>
                                            <p className="mt-3 text-2xl font-semibold tabular-nums">
                                                {tier.limit}
                                                <span className="text-muted-foreground ml-1 text-[10px] font-medium uppercase">
                                                    monitors
                                                </span>
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {!hasAdminLimit ? (
                        <div className="border-border/70 rounded-lg border p-4">
                            {!usage.starred ? (
                                <div className="flex items-start gap-3">
                                    <Github className="mt-0.5 h-4 w-4 shrink-0" />
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Unlock {usage.starLimit} with a
                                            GitHub star
                                        </p>
                                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                                            {githubReady
                                                ? "Star the Vintrack repository, then ask us to check your account again."
                                                : "Connect your GitHub account first. After starring Vintrack, your limit is verified automatically."}
                                        </p>
                                    </div>
                                </div>
                            ) : !usage.donated ? (
                                <div className="flex items-start gap-3">
                                    <Heart className="mt-0.5 h-4 w-4 shrink-0" />
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Permanently unlock{" "}
                                            {usage.donationLimit}
                                        </p>
                                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                                            Any confirmed GitHub Sponsors
                                            donation unlocks the supporter
                                            limit, even after the sponsorship
                                            ends.
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-muted-foreground text-sm leading-6">
                                    You already have the highest reward tier.
                                    Pause another Free Pool monitor or use your
                                    own proxies to add more.
                                </p>
                            )}
                        </div>
                    ) : null}

                    <Link
                        href="/proxies"
                        className="text-muted-foreground hover:text-foreground flex items-center justify-between gap-3 text-xs transition-colors"
                    >
                        <span>
                            Monitors using your own proxies remain unlimited.
                        </span>
                        <span className="flex shrink-0 items-center gap-1 font-medium">
                            Proxy groups <ArrowRight className="h-3 w-3" />
                        </span>
                    </Link>
                </div>

                <DialogFooter className="border-border/70 bg-muted/20 border-t px-5 py-4 sm:px-6">
                    {hasAdminLimit || usage.donated ? (
                        <Button
                            type="button"
                            onClick={() => onOpenChange(false)}
                        >
                            Got it
                        </Button>
                    ) : !githubReady ? (
                        <form action={connectGithubAccount}>
                            <Button type="submit">
                                <Github className="h-4 w-4" />
                                Connect GitHub
                            </Button>
                        </form>
                    ) : !usage.starred ? (
                        <>
                            {usage.repositoryUrl ? (
                                <Button asChild>
                                    <a
                                        href={usage.repositoryUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        <Star className="h-4 w-4" />
                                        Star Vintrack
                                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                                    </a>
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                variant="outline"
                                disabled={checking}
                                onClick={checkAgain}
                            >
                                {checking ? (
                                    <LoaderCircle className="h-4 w-4 animate-spin" />
                                ) : null}
                                {checking
                                    ? "Checking GitHub…"
                                    : "I've starred — check again"}
                            </Button>
                        </>
                    ) : usage.sponsorsUrl ? (
                        <Button asChild>
                            <a
                                href={usage.sponsorsUrl}
                                target="_blank"
                                rel="noreferrer"
                            >
                                <Heart className="h-4 w-4" />
                                Support Vintrack
                                <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                            </a>
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
