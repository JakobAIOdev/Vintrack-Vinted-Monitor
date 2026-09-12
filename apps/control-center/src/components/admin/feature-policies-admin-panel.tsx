"use client";

import { useMemo, useState } from "react";
import { Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
    applyFeaturePolicyChanges,
    previewFeaturePolicyChanges,
    type FeaturePolicyDraft,
    type FeaturePolicyImpact,
} from "@/actions/admin-features";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    FEATURE_DEFINITION_BY_KEY,
    USER_ROLES,
    type FeatureDefinition,
    type FeaturePolicy,
    type UserRole,
} from "@/lib/features";

export type FeatureAdminState = {
    definitions: readonly FeatureDefinition[];
    policies: FeaturePolicy[];
};

function toDrafts(policies: FeaturePolicy[]): FeaturePolicyDraft[] {
    return policies.map((policy) => ({
        feature: policy.feature,
        enabled: policy.enabled,
        roles: { ...policy.roles },
        revision: policy.revision,
    }));
}

function changedPolicy(draft: FeaturePolicyDraft, saved: FeaturePolicyDraft[]) {
    const previous = saved.find((policy) => policy.feature === draft.feature);
    return (
        !previous ||
        previous.enabled !== draft.enabled ||
        USER_ROLES.some((role) => previous.roles[role] !== draft.roles[role])
    );
}

export function FeaturePoliciesAdminPanel({
    initialState,
}: {
    initialState: FeatureAdminState;
}) {
    const initialDrafts = useMemo(
        () => toDrafts(initialState.policies),
        [initialState.policies],
    );
    const [saved, setSaved] = useState(initialDrafts);
    const [drafts, setDrafts] = useState(initialDrafts);
    const [query, setQuery] = useState("");
    const [impacts, setImpacts] = useState<FeaturePolicyImpact[] | null>(null);
    const [reviewing, setReviewing] = useState(false);
    const [saving, setSaving] = useState(false);
    const dirty = drafts.some((draft) => changedPolicy(draft, saved));

    const visibleDefinitions = initialState.definitions.filter((definition) => {
        const needle = query.trim().toLowerCase();
        return (
            !needle ||
            definition.label.toLowerCase().includes(needle) ||
            definition.description.toLowerCase().includes(needle) ||
            definition.disabledEffect.toLowerCase().includes(needle) ||
            definition.group.toLowerCase().includes(needle)
        );
    });

    function updatePolicy(
        feature: FeaturePolicyDraft["feature"],
        update: (current: FeaturePolicyDraft) => FeaturePolicyDraft,
    ) {
        setDrafts((current) =>
            current.map((policy) =>
                policy.feature === feature ? update(policy) : policy,
            ),
        );
    }

    async function reviewChanges() {
        setReviewing(true);
        try {
            const result = await previewFeaturePolicyChanges(drafts);
            setImpacts(result.impacts);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Could not preview feature changes",
            );
        } finally {
            setReviewing(false);
        }
    }

    async function applyChanges() {
        setSaving(true);
        try {
            const changedKeys = new Set(
                drafts
                    .filter((draft) => changedPolicy(draft, saved))
                    .map((draft) => draft.feature),
            );
            const result = await applyFeaturePolicyChanges(drafts);
            const next = drafts.map((draft) => ({
                ...draft,
                revision:
                    draft.revision + (changedKeys.has(draft.feature) ? 1 : 0),
            }));
            setSaved(next);
            setDrafts(next);
            setImpacts(null);
            toast.success(
                `Feature policies saved · ${result.pausedMonitors} monitors and ${result.pausedPriceWatches} Price Watches paused`,
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Could not save feature policies",
            );
        } finally {
            setSaving(false);
        }
    }

    const grouped = Array.from(
        new Set(visibleDefinitions.map((definition) => definition.group)),
    );

    return (
        <div className="space-y-5">
            <div className="border-border/60 bg-card rounded-xl border p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <ShieldCheck className="text-primary size-5" />
                            <h2 className="text-lg font-semibold">
                                Feature access
                            </h2>
                        </div>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Global availability is evaluated before role access
                            and feature dependencies.
                        </p>
                        <div className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
                            <div className="bg-muted/40 rounded-lg p-3">
                                <p className="font-medium">Global</p>
                                <p className="text-muted-foreground mt-1">
                                    Master switch. Off means nobody can see or
                                    use the feature.
                                </p>
                            </div>
                            <div className="bg-muted/40 rounded-lg p-3">
                                <p className="font-medium">
                                    Free / Premium / Admin
                                </p>
                                <p className="text-muted-foreground mt-1">
                                    Controls which roles may use it while the
                                    global switch is on.
                                </p>
                            </div>
                            <div className="bg-muted/40 rounded-lg p-3">
                                <p className="font-medium">Dependencies</p>
                                <p className="text-muted-foreground mt-1">
                                    A required parent feature can still block
                                    access for the same role.
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="relative w-full lg:w-72">
                        <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search features..."
                            className="pl-9"
                        />
                    </div>
                </div>
            </div>

            {grouped.map((group) => (
                <section key={group} className="space-y-2">
                    <h3 className="text-muted-foreground px-1 text-xs font-semibold tracking-wider uppercase">
                        {group}
                    </h3>
                    <div className="border-border/60 bg-card overflow-hidden rounded-xl border">
                        <div className="bg-muted/30 text-muted-foreground hidden grid-cols-[minmax(260px,1fr)_120px_repeat(3,100px)] items-center border-b px-4 py-2 text-[11px] font-semibold tracking-wide uppercase lg:grid">
                            <span>Feature and effect</span>
                            <span className="text-center">Global</span>
                            <span className="text-center">Free</span>
                            <span className="text-center">Premium</span>
                            <span className="text-center">Admin</span>
                        </div>
                        {visibleDefinitions
                            .filter((definition) => definition.group === group)
                            .map((definition) => {
                                const policy = drafts.find(
                                    (candidate) =>
                                        candidate.feature === definition.key,
                                )!;
                                const enabledRoles = USER_ROLES.filter(
                                    (role) =>
                                        policy.enabled && policy.roles[role],
                                );
                                return (
                                    <div
                                        key={definition.key}
                                        className="border-border/60 grid gap-4 border-t p-4 lg:grid-cols-[minmax(260px,1fr)_120px_repeat(3,100px)] lg:items-center"
                                    >
                                        <div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <p className="font-medium">
                                                    {definition.label}
                                                </p>
                                                {definition.dependencies.map(
                                                    (dependency) => (
                                                        <Badge
                                                            key={dependency}
                                                            variant="outline"
                                                            className="font-normal"
                                                        >
                                                            Requires{" "}
                                                            {
                                                                FEATURE_DEFINITION_BY_KEY[
                                                                    dependency
                                                                ].label
                                                            }
                                                        </Badge>
                                                    ),
                                                )}
                                            </div>
                                            <p className="text-muted-foreground mt-1 text-xs leading-5">
                                                {definition.description}
                                            </p>
                                            <p className="mt-1 text-xs leading-5">
                                                <span className="font-medium">
                                                    When disabled:
                                                </span>{" "}
                                                <span className="text-muted-foreground">
                                                    {definition.disabledEffect}
                                                </span>
                                            </p>
                                            <p className="text-muted-foreground mt-2 text-[11px]">
                                                {policy.enabled
                                                    ? enabledRoles.length > 0
                                                        ? `Draft access: ${enabledRoles.join(", ")}`
                                                        : "Draft access: no roles"
                                                    : "Draft access: disabled for everyone"}
                                            </p>
                                        </div>
                                        <label className="flex items-center justify-between gap-2 text-sm lg:justify-center">
                                            <span className="lg:sr-only">
                                                Globally enabled
                                            </span>
                                            <span className="text-muted-foreground lg:hidden">
                                                Global
                                            </span>
                                            <input
                                                aria-label={`${definition.label} globally enabled`}
                                                type="checkbox"
                                                title="Master switch for every role"
                                                checked={policy.enabled}
                                                onChange={(event) =>
                                                    updatePolicy(
                                                        definition.key,
                                                        (current) => ({
                                                            ...current,
                                                            enabled:
                                                                event.target
                                                                    .checked,
                                                        }),
                                                    )
                                                }
                                                className="size-5 accent-current"
                                            />
                                        </label>
                                        {USER_ROLES.map((role) => (
                                            <label
                                                key={role}
                                                className="flex items-center justify-between gap-2 text-sm capitalize lg:justify-center"
                                            >
                                                <span className="lg:sr-only">
                                                    {role}
                                                </span>
                                                <span className="text-muted-foreground lg:hidden">
                                                    {role}
                                                </span>
                                                <input
                                                    aria-label={`${definition.label} for ${role}`}
                                                    type="checkbox"
                                                    title={`Allow ${role} members to use ${definition.label}`}
                                                    checked={
                                                        policy.roles[
                                                            role as UserRole
                                                        ]
                                                    }
                                                    disabled={!policy.enabled}
                                                    onChange={(event) =>
                                                        updatePolicy(
                                                            definition.key,
                                                            (current) => ({
                                                                ...current,
                                                                roles: {
                                                                    ...current.roles,
                                                                    [role]: event
                                                                        .target
                                                                        .checked,
                                                                },
                                                            }),
                                                        )
                                                    }
                                                    className="size-5 accent-current"
                                                />
                                            </label>
                                        ))}
                                    </div>
                                );
                            })}
                    </div>
                </section>
            ))}

            {visibleDefinitions.length === 0 ? (
                <div className="border-border/60 text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
                    No features match your search.
                </div>
            ) : null}

            <div className="border-border/70 bg-background/95 sticky bottom-3 flex items-center justify-between gap-4 rounded-xl border p-3 shadow-lg backdrop-blur">
                <p className="text-muted-foreground text-sm">
                    {dirty
                        ? "You have unsaved feature access changes."
                        : "Feature access is up to date."}
                </p>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        disabled={!dirty || reviewing || saving}
                        onClick={() => setDrafts(saved)}
                    >
                        Discard
                    </Button>
                    <Button
                        disabled={!dirty || reviewing || saving}
                        onClick={reviewChanges}
                    >
                        {reviewing ? "Checking impact..." : "Review changes"}
                    </Button>
                </div>
            </div>

            <Dialog
                open={impacts !== null}
                onOpenChange={(open) => {
                    if (!open && !saving) setImpacts(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Apply feature policy changes?</DialogTitle>
                        <DialogDescription>
                            Access changes apply immediately. Paused jobs will
                            not restart automatically when access is restored.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-2 text-sm">
                        {impacts?.length ? (
                            impacts.map((impact) => (
                                <div
                                    key={impact.feature}
                                    className="border-border/60 rounded-lg border p-3"
                                >
                                    <p className="font-medium">
                                        {
                                            FEATURE_DEFINITION_BY_KEY[
                                                impact.feature
                                            ].label
                                        }
                                    </p>
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        Roles:{" "}
                                        {impact.roles.join(", ") || "none"} ·{" "}
                                        {impact.monitors} monitors ·{" "}
                                        {impact.priceWatches} Price Watches
                                    </p>
                                    {impact.dependentFeatures.length > 0 ? (
                                        <p className="text-muted-foreground mt-1 text-xs">
                                            Dependencies affected:{" "}
                                            {impact.dependentFeatures
                                                .map(
                                                    (feature) =>
                                                        FEATURE_DEFINITION_BY_KEY[
                                                            feature
                                                        ].label,
                                                )
                                                .join(", ")}
                                        </p>
                                    ) : null}
                                </div>
                            ))
                        ) : (
                            <p className="text-muted-foreground">
                                No currently running jobs need to be paused.
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setImpacts(null)}
                        >
                            Cancel
                        </Button>
                        <Button disabled={saving} onClick={applyChanges}>
                            {saving ? "Applying..." : "Apply changes"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
