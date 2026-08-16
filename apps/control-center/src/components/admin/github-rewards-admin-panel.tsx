"use client";

import { useState, useTransition } from "react";
import {
    Activity,
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    CircleDollarSign,
    Clock3,
    Github,
    Heart,
    RefreshCw,
    Save,
    ServerCog,
    ShieldCheck,
    Sparkles,
    Star,
    UsersRound,
    Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
    assignGithubSponsorship,
    previewGithubRewardsEnforcement,
    revokeGithubSponsorship,
    runGithubRewardsSyncAction,
    saveGithubRewardsPolicy,
    testGithubRewardsIntegration,
    type GithubRewardsEnforcementPreview,
    type GithubRewardsAdminState,
} from "@/actions/github-rewards";

const TEXTAREA_CLASS =
    "border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-24 w-full rounded-lg border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

const SECRET_LABELS: Record<string, string> = {
    oauth: "GitHub OAuth",
    repositoryWebhook: "Stars webhook",
    sponsorsWebhook: "Sponsors webhook",
    maintainerToken: "Maintainer token",
    syncSecret: "Scheduler secret",
};

function formatDate(value: string | null | undefined) {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function formatSource(value: string | null | undefined) {
    return value ? value.replaceAll("_", " ") : "unknown";
}

function promptPreview(message: string, current: number, next: number) {
    return message
        .replaceAll("{count}", String(current))
        .replaceAll("{limit}", String(current))
        .replaceAll("{nextLimit}", String(next));
}

export function GithubRewardsAdminPanel({
    initialState,
}: {
    initialState: GithubRewardsAdminState;
}) {
    const [policy, setPolicy] = useState(initialState.policy);
    const [pending, startTransition] = useTransition();
    const [assignments, setAssignments] = useState<Record<string, string>>({});
    const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>(
        {},
    );
    const [preview, setPreview] = useState<{
        signature: string;
        result: GithubRewardsEnforcementPreview;
    } | null>(null);

    const configuredSecrets = Object.values(initialState.secretStatus).filter(
        Boolean,
    ).length;
    const totalSecrets = Object.keys(initialState.secretStatus).length;
    const integrationReady = configuredSecrets === totalSecrets;
    const lastTest = initialState.lastIntegrationTest as {
        testedAt?: string;
        repository?: { ok?: boolean };
        sponsors?: { ok?: boolean };
        rateLimitRemaining?: string | null;
    } | null;
    const recentJobGroups = initialState.recentJobs
        .reduce<
            Array<{
                job: (typeof initialState.recentJobs)[number];
                attempts: number;
            }>
        >((groups, job) => {
            const previous = groups.at(-1);
            if (
                previous &&
                previous.job.type === job.type &&
                previous.job.status === job.status &&
                previous.job.error === job.error
            ) {
                previous.attempts += 1;
            } else {
                groups.push({ job, attempts: 1 });
            }
            return groups;
        }, [])
        .slice(0, 6);

    const loadPreview = async () => {
        const result = await previewGithubRewardsEnforcement(policy);
        setPreview({ signature: JSON.stringify(policy), result });
        return result;
    };

    const save = () => {
        startTransition(async () => {
            try {
                const signature = JSON.stringify(policy);
                const enforcementPreview = await loadPreview();
                if (
                    enforcementPreview.monitorsToPause > 0 &&
                    preview?.signature !== signature
                ) {
                    toast.warning(
                        `Review the preview first: ${enforcementPreview.monitorsToPause} monitors would be paused. Save again to confirm.`,
                    );
                    return;
                }
                const result = await saveGithubRewardsPolicy({
                    ...policy,
                    version: policy.version || `github-rewards-${Date.now()}`,
                });
                setPolicy(result.policy);
                setPreview(null);
                toast.success(
                    result.reconciliation.pausedCount > 0
                        ? `Policy saved; ${result.reconciliation.pausedCount} excess monitors paused`
                        : "Reward policy saved",
                );
            } catch (error) {
                toast.error(
                    error instanceof Error ? error.message : "Save failed",
                );
            }
        });
    };

    const previewPolicy = () => {
        startTransition(async () => {
            try {
                const result = await loadPreview();
                toast.info(
                    `${result.affectedMembers} members affected; ${result.monitorsToPause} monitors would be paused`,
                );
            } catch (error) {
                toast.error(
                    error instanceof Error ? error.message : "Preview failed",
                );
            }
        });
    };

    const sync = () => {
        startTransition(async () => {
            try {
                const result = await runGithubRewardsSyncAction();
                if (!result.ok) {
                    toast.error(result.error);
                    return;
                }
                toast.success(
                    `Sync complete: ${result.stars} stars and ${result.sponsorships} sponsorships`,
                );
            } catch (error) {
                toast.error(
                    error instanceof Error ? error.message : "Sync failed",
                );
            }
        });
    };

    const testIntegration = () => {
        startTransition(async () => {
            try {
                const result = await testGithubRewardsIntegration();
                if (result.repository.ok && result.sponsors.ok) {
                    toast.success(
                        `GitHub APIs healthy; ${result.rateLimitRemaining ?? "?"} requests remaining`,
                        {
                            description:
                                result.starSource.mode === "snapshot"
                                    ? "Stars are read from one repository-wide stargazer snapshot."
                                    : result.starSource.mode === "per_member"
                                      ? "This token cannot list stargazers, so stars are checked per member instead."
                                      : undefined,
                        },
                    );
                } else {
                    toast.error(
                        result.error ??
                            "One or more GitHub integration checks failed",
                    );
                }
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : "Integration test failed",
                );
            }
        });
    };

    return (
        <div className="space-y-4" data-testid="github-rewards-admin">
            <section className="border-border/70 relative overflow-hidden rounded-xl border bg-[linear-gradient(145deg,var(--card),color-mix(in_oklab,var(--muted)_55%,var(--card)))] p-4 shadow-sm sm:p-5">
                <div className="bg-foreground/[0.04] absolute -top-24 -right-16 h-64 w-64 rounded-full blur-3xl" />
                <div className="relative flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex items-start gap-3">
                        <div className="bg-foreground text-background flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm">
                            <Github className="h-5 w-5" />
                        </div>
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-lg font-semibold tracking-tight">
                                    GitHub Rewards
                                </h2>
                                <Badge
                                    variant={
                                        policy.enforcementEnabled
                                            ? "default"
                                            : "secondary"
                                    }
                                    className="rounded-full"
                                >
                                    {policy.enforcementEnabled
                                        ? "Enforcing"
                                        : "Preview mode"}
                                </Badge>
                            </div>
                            <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-5">
                                Manage Free Pool reward limits, verify the
                                GitHub integration, and review donations.
                                Member-specific limits remain in the central
                                Members area.
                            </p>
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                        <Button
                            variant="outline"
                            onClick={previewPolicy}
                            disabled={pending}
                            className="bg-background/70"
                        >
                            <ShieldCheck className="h-4 w-4" />
                            Preview impact
                        </Button>
                        <Button
                            variant="outline"
                            onClick={sync}
                            disabled={pending}
                            className="bg-background/70"
                        >
                            <RefreshCw
                                className={cn(
                                    "h-4 w-4",
                                    pending && "animate-spin",
                                )}
                            />
                            Sync now
                        </Button>
                        <Button
                            onClick={save}
                            disabled={pending}
                            className="col-span-2 sm:col-auto"
                        >
                            <Save className="h-4 w-4" />
                            Save policy
                        </Button>
                    </div>
                </div>
            </section>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                    {
                        label: "GitHub linked",
                        value: initialState.counts.linked,
                        detail: "Member identities",
                        icon: UsersRound,
                    },
                    {
                        label: "Verified stars",
                        value: initialState.counts.starred,
                        detail: `${policy.starLimit} monitor tier`,
                        icon: Star,
                    },
                    {
                        label: "Sponsorships",
                        value: initialState.counts.sponsorships,
                        detail: "Lifetime rewards",
                        icon: Heart,
                    },
                    {
                        label: "Needs review",
                        value: initialState.counts.unmatched,
                        detail:
                            initialState.counts.unmatched > 0
                                ? "Organization donations"
                                : "Queue is clear",
                        icon:
                            initialState.counts.unmatched > 0
                                ? AlertTriangle
                                : CheckCircle2,
                    },
                ].map(({ label, value, detail, icon: Icon }) => (
                    <Card
                        key={label}
                        className="border-border/70 py-0 shadow-sm"
                    >
                        <CardContent className="flex items-center gap-3 p-4">
                            <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
                                <Icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-2xl font-semibold tracking-tight tabular-nums">
                                    {value}
                                </p>
                                <p className="text-sm font-medium">{label}</p>
                                <p className="text-muted-foreground truncate text-xs">
                                    {detail}
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.7fr)]">
                <Card className="border-border/70 gap-0 py-0 shadow-sm">
                    <CardHeader className="border-b p-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <CardTitle>Reward policy</CardTitle>
                                <CardDescription className="mt-1.5 leading-5">
                                    Limits apply only to running Free Proxy Pool
                                    monitors.
                                </CardDescription>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Badge
                                    variant="outline"
                                    className="rounded-full"
                                >
                                    Version {policy.version}
                                </Badge>
                                <Badge
                                    variant="outline"
                                    className="rounded-full"
                                >
                                    Fallback every {policy.syncIntervalMinutes}m
                                </Badge>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-5 p-5">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="border-border/70 bg-muted/20 flex cursor-pointer items-center justify-between gap-4 rounded-xl border p-4">
                                <span>
                                    <span className="block text-sm font-semibold">
                                        Reward integration
                                    </span>
                                    <span className="text-muted-foreground mt-0.5 block text-xs">
                                        Collect stars and sponsorships
                                    </span>
                                </span>
                                <Switch
                                    checked={policy.integrationEnabled}
                                    onCheckedChange={(checked) =>
                                        setPolicy((current) => ({
                                            ...current,
                                            integrationEnabled: checked,
                                        }))
                                    }
                                />
                            </label>
                            <label
                                className={cn(
                                    "flex cursor-pointer items-center justify-between gap-4 rounded-xl border p-4",
                                    policy.enforcementEnabled
                                        ? "border-amber-500/30 bg-amber-500/[0.07]"
                                        : "border-border/70 bg-muted/20",
                                )}
                            >
                                <span>
                                    <span className="block text-sm font-semibold">
                                        Enforce limits
                                    </span>
                                    <span className="text-muted-foreground mt-0.5 block text-xs">
                                        May pause newest excess monitors
                                    </span>
                                </span>
                                <Switch
                                    checked={policy.enforcementEnabled}
                                    onCheckedChange={(checked) =>
                                        setPolicy((current) => ({
                                            ...current,
                                            enforcementEnabled: checked,
                                        }))
                                    }
                                />
                            </label>
                        </div>

                        <div>
                            <div className="mb-3">
                                <p className="text-sm font-semibold">
                                    Limit ladder
                                </p>
                                <p className="text-muted-foreground mt-0.5 text-xs">
                                    Keep each tier higher than the previous
                                    tier.
                                </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                                {(
                                    [
                                        {
                                            label: "Default",
                                            key: "defaultLimit",
                                            detail: "Every eligible member",
                                            icon: ShieldCheck,
                                        },
                                        {
                                            label: "GitHub Star",
                                            key: "starLimit",
                                            detail: "Current verified star",
                                            icon: Star,
                                        },
                                        {
                                            label: "Supporter",
                                            key: "donationLimit",
                                            detail: "Permanent after donation",
                                            icon: Heart,
                                        },
                                    ] as const
                                ).map(({ label, key, detail, icon: Icon }) => (
                                    <div
                                        key={key}
                                        className="border-border/70 rounded-xl border p-4"
                                    >
                                        <div className="mb-4 flex items-center gap-2">
                                            <div className="bg-muted flex h-8 w-8 items-center justify-center rounded-lg">
                                                <Icon className="h-3.5 w-3.5" />
                                            </div>
                                            <div>
                                                <Label
                                                    htmlFor={`reward-${key}`}
                                                    className="text-sm font-semibold"
                                                >
                                                    {label}
                                                </Label>
                                                <p className="text-muted-foreground text-[11px]">
                                                    {detail}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="relative">
                                            <Input
                                                id={`reward-${key}`}
                                                type="number"
                                                min={0}
                                                value={policy[key]}
                                                onChange={(event) =>
                                                    setPolicy((current) => ({
                                                        ...current,
                                                        [key]: Number(
                                                            event.target.value,
                                                        ),
                                                    }))
                                                }
                                                className="h-11 pr-20 text-lg font-semibold tabular-nums"
                                            />
                                            <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[10px] uppercase">
                                                monitors
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div>
                            <p className="mb-2 text-sm font-semibold">
                                Eligible roles
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {(["free", "premium"] as const).map((role) => {
                                    const checked =
                                        policy.eligibleRoles.includes(role);
                                    return (
                                        <label
                                            key={role}
                                            className={cn(
                                                "cursor-pointer rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                                                checked
                                                    ? "border-foreground bg-foreground text-background"
                                                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                                            )}
                                        >
                                            <input
                                                type="checkbox"
                                                className="sr-only"
                                                checked={checked}
                                                onChange={(event) =>
                                                    setPolicy((current) => ({
                                                        ...current,
                                                        eligibleRoles: event
                                                            .target.checked
                                                            ? Array.from(
                                                                  new Set([
                                                                      ...current.eligibleRoles,
                                                                      role,
                                                                  ]),
                                                              )
                                                            : current.eligibleRoles.filter(
                                                                  (value) =>
                                                                      value !==
                                                                      role,
                                                              ),
                                                    }))
                                                }
                                            />
                                            {checked ? "✓ " : ""}
                                            {role}
                                        </label>
                                    );
                                })}
                            </div>
                        </div>

                        <details className="group border-border/70 overflow-hidden rounded-xl border">
                            <summary className="hover:bg-muted/30 flex cursor-pointer list-none items-center justify-between gap-3 p-4 transition-colors">
                                <div className="flex items-center gap-3">
                                    <ServerCog className="text-muted-foreground h-4 w-4" />
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Repository &amp; sync
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            {policy.repositoryOwner}/
                                            {policy.repositoryName} · Sponsors @
                                            {policy.sponsorsLogin}
                                        </p>
                                    </div>
                                </div>
                                <ChevronDown className="text-muted-foreground h-4 w-4 transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="border-t p-4">
                                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                    <div className="space-y-2">
                                        <Label htmlFor="reward-repository-owner">
                                            Repository owner
                                        </Label>
                                        <Input
                                            id="reward-repository-owner"
                                            value={policy.repositoryOwner}
                                            onChange={(event) =>
                                                setPolicy((current) => ({
                                                    ...current,
                                                    repositoryOwner:
                                                        event.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="reward-repository-name">
                                            Repository name
                                        </Label>
                                        <Input
                                            id="reward-repository-name"
                                            value={policy.repositoryName}
                                            onChange={(event) =>
                                                setPolicy((current) => ({
                                                    ...current,
                                                    repositoryName:
                                                        event.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="reward-sponsors-login">
                                            Sponsors login
                                        </Label>
                                        <Input
                                            id="reward-sponsors-login"
                                            value={policy.sponsorsLogin}
                                            onChange={(event) =>
                                                setPolicy((current) => ({
                                                    ...current,
                                                    sponsorsLogin:
                                                        event.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2 sm:col-span-1">
                                        <Label htmlFor="reward-sync-interval">
                                            Fallback reconciliation (minutes)
                                        </Label>
                                        <Input
                                            id="reward-sync-interval"
                                            type="number"
                                            min={5}
                                            value={policy.syncIntervalMinutes}
                                            onChange={(event) =>
                                                setPolicy((current) => ({
                                                    ...current,
                                                    syncIntervalMinutes: Number(
                                                        event.target.value,
                                                    ),
                                                }))
                                            }
                                        />
                                        <p className="text-muted-foreground text-xs leading-5">
                                            Stars and donations apply
                                            immediately through member checks
                                            and webhooks. This interval only
                                            repairs missed events.
                                        </p>
                                    </div>
                                    <div className="space-y-2 sm:col-span-2">
                                        <Label htmlFor="reward-policy-version">
                                            Policy / announcement version
                                        </Label>
                                        <Input
                                            id="reward-policy-version"
                                            value={policy.version}
                                            onChange={(event) =>
                                                setPolicy((current) => ({
                                                    ...current,
                                                    version: event.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                </div>
                            </div>
                        </details>

                        <details className="group border-border/70 overflow-hidden rounded-xl border">
                            <summary className="hover:bg-muted/30 flex cursor-pointer list-none items-center justify-between gap-3 p-4 transition-colors">
                                <div className="flex items-center gap-3">
                                    <Sparkles className="text-muted-foreground h-4 w-4" />
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Member messaging
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            Announcement and limit-reached copy
                                        </p>
                                    </div>
                                </div>
                                <ChevronDown className="text-muted-foreground h-4 w-4 transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="space-y-5 border-t p-4">
                                <label className="bg-muted/20 flex items-center justify-between gap-4 rounded-xl border p-3.5">
                                    <span>
                                        <span className="block text-sm font-medium">
                                            One-time announcement
                                        </span>
                                        <span className="text-muted-foreground block text-xs">
                                            Show once per policy version
                                        </span>
                                    </span>
                                    <Switch
                                        checked={policy.announcementEnabled}
                                        onCheckedChange={(checked) =>
                                            setPolicy((current) => ({
                                                ...current,
                                                announcementEnabled: checked,
                                            }))
                                        }
                                    />
                                </label>
                                <div className="grid gap-4 lg:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor="reward-announcement-title">
                                            Announcement title
                                        </Label>
                                        <Input
                                            id="reward-announcement-title"
                                            value={policy.announcementTitle}
                                            onChange={(event) =>
                                                setPolicy((current) => ({
                                                    ...current,
                                                    announcementTitle:
                                                        event.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2 lg:row-span-2">
                                        <Label htmlFor="reward-announcement-message">
                                            Announcement message
                                        </Label>
                                        <textarea
                                            id="reward-announcement-message"
                                            value={policy.announcementMessage}
                                            onChange={(event) =>
                                                setPolicy((current) => ({
                                                    ...current,
                                                    announcementMessage:
                                                        event.target.value,
                                                }))
                                            }
                                            rows={4}
                                            className={TEXTAREA_CLASS}
                                        />
                                    </div>
                                </div>

                                <div className="grid gap-4 xl:grid-cols-3">
                                    {(
                                        [
                                            {
                                                label: "Star prompt",
                                                titleKey: "starPromptTitle",
                                                messageKey: "starPromptMessage",
                                                current: policy.defaultLimit,
                                                next: policy.starLimit,
                                            },
                                            {
                                                label: "Donation prompt",
                                                titleKey: "donationPromptTitle",
                                                messageKey:
                                                    "donationPromptMessage",
                                                current: policy.starLimit,
                                                next: policy.donationLimit,
                                            },
                                            {
                                                label: "Hard limit",
                                                titleKey: "hardLimitTitle",
                                                messageKey: "hardLimitMessage",
                                                current: policy.donationLimit,
                                                next: policy.donationLimit,
                                            },
                                        ] as const
                                    ).map((item) => (
                                        <div
                                            key={item.label}
                                            className="space-y-3 rounded-xl border p-3.5"
                                        >
                                            <p className="text-xs font-semibold tracking-wide uppercase">
                                                {item.label}
                                            </p>
                                            <Input
                                                value={policy[item.titleKey]}
                                                aria-label={`${item.label} title`}
                                                onChange={(event) =>
                                                    setPolicy((current) => ({
                                                        ...current,
                                                        [item.titleKey]:
                                                            event.target.value,
                                                    }))
                                                }
                                            />
                                            <textarea
                                                value={policy[item.messageKey]}
                                                aria-label={`${item.label} message`}
                                                onChange={(event) =>
                                                    setPolicy((current) => ({
                                                        ...current,
                                                        [item.messageKey]:
                                                            event.target.value,
                                                    }))
                                                }
                                                rows={4}
                                                className={TEXTAREA_CLASS}
                                            />
                                            <div className="bg-muted/35 rounded-lg p-3">
                                                <p className="text-xs font-semibold">
                                                    {policy[item.titleKey]}
                                                </p>
                                                <p className="text-muted-foreground mt-1 text-[11px] leading-4">
                                                    {promptPreview(
                                                        policy[item.messageKey],
                                                        item.current,
                                                        item.next,
                                                    )}
                                                </p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </details>
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    <Card className="border-border/70 gap-0 py-0 shadow-sm">
                        <CardHeader className="border-b p-5">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <CardTitle>Integration health</CardTitle>
                                    <CardDescription className="mt-1.5">
                                        Secrets, APIs and delivery endpoints
                                    </CardDescription>
                                </div>
                                <Badge
                                    variant={
                                        integrationReady
                                            ? "default"
                                            : "destructive"
                                    }
                                    className="rounded-full"
                                >
                                    {configuredSecrets}/{totalSecrets} ready
                                </Badge>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4 p-5">
                            <div className="space-y-2">
                                {Object.entries(initialState.secretStatus).map(
                                    ([key, configured]) => (
                                        <div
                                            key={key}
                                            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                                        >
                                            <span className="text-sm">
                                                {SECRET_LABELS[key] ?? key}
                                            </span>
                                            <span
                                                className={cn(
                                                    "inline-flex items-center gap-1.5 text-xs font-medium",
                                                    configured
                                                        ? "text-emerald-700 dark:text-emerald-300"
                                                        : "text-destructive",
                                                )}
                                            >
                                                {configured ? (
                                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                                ) : (
                                                    <AlertTriangle className="h-3.5 w-3.5" />
                                                )}
                                                {configured
                                                    ? "Configured"
                                                    : "Missing"}
                                            </span>
                                        </div>
                                    ),
                                )}
                            </div>
                            <Button
                                variant="outline"
                                className="w-full"
                                onClick={testIntegration}
                                disabled={pending}
                            >
                                <Activity className="h-4 w-4" />
                                Test GitHub APIs
                            </Button>
                            {lastTest ? (
                                <div className="bg-muted/30 rounded-xl border p-3 text-xs">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-medium">
                                            Last API test
                                        </span>
                                        <span className="text-muted-foreground">
                                            {formatDate(lastTest.testedAt)}
                                        </span>
                                    </div>
                                    <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1">
                                        <span>
                                            Repository:{" "}
                                            {lastTest.repository?.ok
                                                ? "OK"
                                                : "Failed"}
                                        </span>
                                        <span>
                                            Sponsors:{" "}
                                            {lastTest.sponsors?.ok
                                                ? "OK"
                                                : "Failed"}
                                        </span>
                                        <span>
                                            Rate limit:{" "}
                                            {lastTest.rateLimitRemaining ?? "—"}
                                        </span>
                                    </div>
                                </div>
                            ) : null}
                            <details className="group rounded-xl border">
                                <summary className="flex cursor-pointer list-none items-center justify-between p-3 text-xs font-medium">
                                    Callback &amp; webhook URLs
                                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                                </summary>
                                <div className="text-muted-foreground space-y-2 border-t p-3 font-mono text-[10px] leading-4 break-all">
                                    <p>/api/auth/callback/github</p>
                                    <p>
                                        /api/github-rewards/webhooks/repository
                                    </p>
                                    <p>/api/github-rewards/webhooks/sponsors</p>
                                </div>
                            </details>
                        </CardContent>
                    </Card>

                    <Card
                        className={cn(
                            "border-border/70 gap-0 py-0 shadow-sm",
                            initialState.counts.unmatched > 0 &&
                                "border-amber-500/35",
                        )}
                    >
                        <CardHeader className="border-b p-5">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <CardTitle>Review queue</CardTitle>
                                    <CardDescription className="mt-1.5">
                                        Organization donations need a member
                                        assignment.
                                    </CardDescription>
                                </div>
                                <Badge
                                    variant={
                                        initialState.counts.unmatched > 0
                                            ? "secondary"
                                            : "outline"
                                    }
                                    className="rounded-full"
                                >
                                    {initialState.counts.unmatched} open
                                </Badge>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-3 p-5">
                            {initialState.unmatched.length === 0 ? (
                                <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3 text-sm">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                    No donations need review.
                                </div>
                            ) : (
                                initialState.unmatched.map((sponsorship) => (
                                    <div
                                        key={sponsorship.id}
                                        className="space-y-3 rounded-xl border p-3.5"
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-semibold">
                                                    @{sponsorship.login}
                                                </p>
                                                <p className="text-muted-foreground mt-0.5 text-xs">
                                                    {sponsorship.accountType} ·{" "}
                                                    {sponsorship.isOneTime
                                                        ? "one-time"
                                                        : "monthly"}{" "}
                                                    ·{" "}
                                                    {sponsorship.amountCents ===
                                                    null
                                                        ? "amount unavailable"
                                                        : `$${(
                                                              sponsorship.amountCents /
                                                              100
                                                          ).toFixed(2)}`}
                                                </p>
                                            </div>
                                            <CircleDollarSign className="text-muted-foreground h-4 w-4" />
                                        </div>
                                        <select
                                            className="border-input bg-background h-9 w-full rounded-lg border px-3 text-sm"
                                            value={
                                                assignments[sponsorship.id] ??
                                                ""
                                            }
                                            onChange={(event) =>
                                                setAssignments((current) => ({
                                                    ...current,
                                                    [sponsorship.id]:
                                                        event.target.value,
                                                }))
                                            }
                                        >
                                            <option value="">
                                                Assign to member…
                                            </option>
                                            {initialState.members.map(
                                                (member) => (
                                                    <option
                                                        key={member.id}
                                                        value={member.id}
                                                    >
                                                        {member.name ||
                                                            member.email ||
                                                            member.id}{" "}
                                                        ({member.role})
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                        <div className="flex gap-2">
                                            <Button
                                                size="sm"
                                                className="flex-1"
                                                disabled={
                                                    pending ||
                                                    !assignments[sponsorship.id]
                                                }
                                                onClick={() =>
                                                    startTransition(
                                                        async () => {
                                                            await assignGithubSponsorship(
                                                                sponsorship.id,
                                                                assignments[
                                                                    sponsorship
                                                                        .id
                                                                ],
                                                            );
                                                            toast.success(
                                                                "Donation assigned",
                                                            );
                                                        },
                                                    )
                                                }
                                            >
                                                Assign reward
                                            </Button>
                                        </div>
                                        <details className="group">
                                            <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none text-xs">
                                                Reject this donation
                                            </summary>
                                            <div className="mt-2 flex gap-2">
                                                <Input
                                                    placeholder="Required reason"
                                                    value={
                                                        revokeReasons[
                                                            sponsorship.id
                                                        ] ?? ""
                                                    }
                                                    onChange={(event) =>
                                                        setRevokeReasons(
                                                            (current) => ({
                                                                ...current,
                                                                [sponsorship.id]:
                                                                    event.target
                                                                        .value,
                                                            }),
                                                        )
                                                    }
                                                />
                                                <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    disabled={
                                                        pending ||
                                                        !revokeReasons[
                                                            sponsorship.id
                                                        ]?.trim()
                                                    }
                                                    onClick={() =>
                                                        startTransition(
                                                            async () => {
                                                                await revokeGithubSponsorship(
                                                                    sponsorship.id,
                                                                    revokeReasons[
                                                                        sponsorship
                                                                            .id
                                                                    ],
                                                                );
                                                                toast.success(
                                                                    "Donation rejected",
                                                                );
                                                            },
                                                        )
                                                    }
                                                >
                                                    Reject
                                                </Button>
                                            </div>
                                        </details>
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            {preview ? (
                <Card className="gap-0 border-amber-500/30 py-0 shadow-sm">
                    <CardHeader className="border-b p-5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <CardTitle>Enforcement preview</CardTitle>
                                <CardDescription className="mt-1.5">
                                    Exact changes if this policy is saved now.
                                </CardDescription>
                            </div>
                            <div className="flex gap-2">
                                <Badge
                                    variant="outline"
                                    className="rounded-full"
                                >
                                    {preview.result.affectedMembers} members
                                </Badge>
                                <Badge
                                    variant="secondary"
                                    className="rounded-full"
                                >
                                    {preview.result.monitorsToPause} pauses
                                </Badge>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="p-5">
                        {preview.result.affected.length === 0 ? (
                            <div className="flex items-center gap-2 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                                <CheckCircle2 className="h-4 w-4" />
                                No monitors would be paused.
                            </div>
                        ) : (
                            <div className="grid gap-3 lg:grid-cols-2">
                                {preview.result.affected.map((row) => (
                                    <div
                                        key={row.userId}
                                        className="rounded-xl border p-3.5 text-sm"
                                    >
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="font-semibold">
                                                {row.member}
                                            </span>
                                            <Badge variant="secondary">
                                                {row.currentLimit ?? "∞"} →{" "}
                                                {row.projectedLimit ?? "∞"}
                                            </Badge>
                                        </div>
                                        <p className="text-muted-foreground mt-2 text-xs capitalize">
                                            {formatSource(row.projectedSource)}
                                        </p>
                                        <p className="mt-2 text-xs leading-5">
                                            {row.monitorsToPause
                                                .map(
                                                    (monitor) =>
                                                        `${monitor.name} (#${monitor.id})`,
                                                )
                                                .join(", ")}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            ) : null}

            <div className="grid items-start gap-4 xl:grid-cols-2">
                <Card className="border-border/70 gap-0 py-0 shadow-sm">
                    <CardHeader className="border-b p-5">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <CardTitle>Donation history</CardTitle>
                                <CardDescription className="mt-1.5">
                                    Recent verified and revoked rewards
                                </CardDescription>
                            </div>
                            <CircleDollarSign className="text-muted-foreground h-4 w-4" />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2 p-5">
                        {initialState.recentSponsorships.length === 0 ? (
                            <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
                                No sponsorships recorded yet.
                            </p>
                        ) : (
                            initialState.recentSponsorships
                                .slice(0, 12)
                                .map((sponsorship) => (
                                    <details
                                        key={sponsorship.id}
                                        className="group rounded-xl border"
                                    >
                                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3.5">
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-semibold">
                                                    @{sponsorship.login}
                                                </p>
                                                <p className="text-muted-foreground mt-0.5 text-xs">
                                                    {sponsorship.isOneTime
                                                        ? "One-time"
                                                        : "Recurring"}{" "}
                                                    · {sponsorship.source} ·{" "}
                                                    {new Date(
                                                        sponsorship.sponsoredAt,
                                                    ).toLocaleDateString()}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Badge
                                                    variant={
                                                        sponsorship.revokedAt
                                                            ? "destructive"
                                                            : "default"
                                                    }
                                                    className="rounded-full"
                                                >
                                                    {sponsorship.revokedAt
                                                        ? "Revoked"
                                                        : "Lifetime"}
                                                </Badge>
                                                <ChevronDown className="text-muted-foreground h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                                            </div>
                                        </summary>
                                        <div className="border-t p-3.5">
                                            <div className="text-muted-foreground mb-3 grid gap-1 text-xs sm:grid-cols-2">
                                                <p>
                                                    Status:{" "}
                                                    {sponsorship.isActive
                                                        ? "active"
                                                        : "ended"}
                                                </p>
                                                <p>
                                                    Amount:{" "}
                                                    {sponsorship.amountCents ===
                                                    null
                                                        ? "unavailable"
                                                        : `$${(
                                                              sponsorship.amountCents /
                                                              100
                                                          ).toFixed(2)}`}
                                                </p>
                                            </div>
                                            {!sponsorship.revokedAt ? (
                                                <div className="flex gap-2">
                                                    <Input
                                                        placeholder="Required revoke reason"
                                                        value={
                                                            revokeReasons[
                                                                sponsorship.id
                                                            ] ?? ""
                                                        }
                                                        onChange={(event) =>
                                                            setRevokeReasons(
                                                                (current) => ({
                                                                    ...current,
                                                                    [sponsorship.id]:
                                                                        event
                                                                            .target
                                                                            .value,
                                                                }),
                                                            )
                                                        }
                                                    />
                                                    <Button
                                                        variant="destructive"
                                                        size="sm"
                                                        disabled={
                                                            pending ||
                                                            !revokeReasons[
                                                                sponsorship.id
                                                            ]?.trim()
                                                        }
                                                        onClick={() =>
                                                            startTransition(
                                                                async () => {
                                                                    await revokeGithubSponsorship(
                                                                        sponsorship.id,
                                                                        revokeReasons[
                                                                            sponsorship
                                                                                .id
                                                                        ],
                                                                    );
                                                                    toast.success(
                                                                        "Reward revoked and member reconciled",
                                                                    );
                                                                },
                                                            )
                                                        }
                                                    >
                                                        Revoke
                                                    </Button>
                                                </div>
                                            ) : (
                                                <p className="text-destructive text-xs">
                                                    {sponsorship.revokeReason ||
                                                        "No reason recorded"}
                                                </p>
                                            )}
                                        </div>
                                    </details>
                                ))
                        )}
                    </CardContent>
                </Card>

                <Card className="border-border/70 gap-0 py-0 shadow-sm">
                    <CardHeader className="border-b p-5">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <CardTitle>Recent activity</CardTitle>
                                <CardDescription className="mt-1.5">
                                    Sync jobs and webhook deliveries
                                </CardDescription>
                            </div>
                            <Activity className="text-muted-foreground h-4 w-4" />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-5 p-5">
                        <div>
                            <div className="mb-2 flex items-center gap-2">
                                <Clock3 className="text-muted-foreground h-3.5 w-3.5" />
                                <p className="text-xs font-semibold tracking-wide uppercase">
                                    Fallback reconciliation
                                </p>
                            </div>
                            <div className="space-y-2">
                                {recentJobGroups.length === 0 ? (
                                    <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
                                        No sync jobs yet.
                                    </p>
                                ) : (
                                    recentJobGroups.map(({ job, attempts }) => (
                                        <div
                                            key={job.id}
                                            className="bg-muted/25 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                                        >
                                            <div className="min-w-0">
                                                <p className="truncate text-xs font-medium capitalize">
                                                    {job.type === "full_sync"
                                                        ? "Full fallback scan"
                                                        : formatSource(
                                                              job.type,
                                                          )}
                                                </p>
                                                <p className="text-muted-foreground mt-0.5 text-[10px]">
                                                    {job.processed} processed ·{" "}
                                                    {formatDate(job.startedAt)}
                                                    {attempts > 1
                                                        ? ` · ${attempts} similar failures`
                                                        : ""}
                                                </p>
                                            </div>
                                            <Badge
                                                variant={
                                                    job.status === "completed"
                                                        ? "default"
                                                        : job.status ===
                                                            "failed"
                                                          ? "destructive"
                                                          : "secondary"
                                                }
                                                className="rounded-full text-[10px] capitalize"
                                            >
                                                {job.status}
                                            </Badge>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        <div className="border-t pt-4">
                            <div className="mb-2 flex items-center gap-2">
                                <Webhook className="text-muted-foreground h-3.5 w-3.5" />
                                <p className="text-xs font-semibold tracking-wide uppercase">
                                    Webhooks
                                </p>
                            </div>
                            <div className="space-y-2">
                                {initialState.deliveries.length === 0 ? (
                                    <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
                                        No webhook deliveries yet.
                                    </p>
                                ) : (
                                    initialState.deliveries
                                        .slice(0, 6)
                                        .map((delivery) => (
                                            <div
                                                key={delivery.id}
                                                className="bg-muted/25 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                                            >
                                                <div className="min-w-0">
                                                    <p className="truncate text-xs font-medium">
                                                        {delivery.event}.
                                                        {delivery.action ??
                                                            "received"}
                                                    </p>
                                                    <p className="text-muted-foreground mt-0.5 text-[10px]">
                                                        {formatDate(
                                                            delivery.receivedAt,
                                                        )}
                                                    </p>
                                                </div>
                                                <Badge
                                                    variant={
                                                        delivery.status ===
                                                        "processed"
                                                            ? "default"
                                                            : "destructive"
                                                    }
                                                    className="rounded-full text-[10px] capitalize"
                                                >
                                                    {delivery.status}
                                                </Badge>
                                            </div>
                                        ))
                                )}
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs">
                <span>Prompts shown: {initialState.promptStats.shown}</span>
                <span>CTA clicks: {initialState.promptStats.clicked}</span>
                <span>
                    Integration: {policy.integrationEnabled ? "on" : "off"}
                </span>
                <span>
                    Enforcement: {policy.enforcementEnabled ? "on" : "off"}
                </span>
            </div>
        </div>
    );
}
