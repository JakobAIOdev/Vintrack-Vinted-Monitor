"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
    FEATURE_DEFINITIONS,
    FEATURE_KEYS,
    USER_ROLES,
    isFeatureKey,
    resolveFeatureAccess,
    type FeatureKey,
    type FeaturePolicy,
    type UserRole,
} from "@/lib/features";
import { loadFeaturePolicies } from "@/lib/features.server";

export type FeaturePolicyDraft = {
    feature: FeatureKey;
    enabled: boolean;
    roles: Record<UserRole, boolean>;
    revision: number;
};

export type FeaturePolicyImpact = {
    feature: FeatureKey;
    roles: UserRole[];
    deniedRoles: UserRole[];
    monitors: number;
    priceWatches: number;
    dependentFeatures: FeatureKey[];
};

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id || session.user.role !== "admin") {
        throw new Error("Unauthorized");
    }
    return session.user.id;
}

function normalizeDrafts(input: FeaturePolicyDraft[]) {
    if (!Array.isArray(input) || input.length !== FEATURE_KEYS.length) {
        throw new Error("A complete feature policy snapshot is required");
    }
    const seen = new Set<FeatureKey>();
    return input.map((draft) => {
        if (!isFeatureKey(draft.feature) || seen.has(draft.feature)) {
            throw new Error("Invalid or duplicate feature");
        }
        seen.add(draft.feature);
        if (
            typeof draft.enabled !== "boolean" ||
            !Number.isInteger(draft.revision) ||
            draft.revision < 0 ||
            USER_ROLES.some((role) => typeof draft.roles?.[role] !== "boolean")
        ) {
            throw new Error(`Invalid policy for ${draft.feature}`);
        }
        return draft;
    });
}

function draftMap(drafts: FeaturePolicyDraft[]) {
    return new Map<FeatureKey, FeaturePolicy>(
        drafts.map((draft) => [
            draft.feature,
            {
                ...draft,
                updatedAt: null,
            },
        ]),
    );
}

function newlyDeniedRoles(
    feature: FeatureKey,
    current: ReadonlyMap<FeatureKey, FeaturePolicy>,
    proposed: ReadonlyMap<FeatureKey, FeaturePolicy>,
) {
    return USER_ROLES.filter(
        (role) =>
            resolveFeatureAccess(feature, role, current).allowed &&
            !resolveFeatureAccess(feature, role, proposed).allowed,
    );
}

async function calculateImpacts(
    drafts: FeaturePolicyDraft[],
    current: ReadonlyMap<FeatureKey, FeaturePolicy>,
    client: Pick<typeof db, "monitors" | "price_watches"> = db,
): Promise<FeaturePolicyImpact[]> {
    const proposed = draftMap(drafts);
    const impacts: FeaturePolicyImpact[] = [];

    for (const feature of FEATURE_KEYS) {
        const before = current.get(feature)!;
        const after = proposed.get(feature)!;
        const changed =
            before.enabled !== after.enabled ||
            USER_ROLES.some((role) => before.roles[role] !== after.roles[role]);
        if (!changed) continue;

        const roles = USER_ROLES.filter(
            (role) =>
                resolveFeatureAccess(feature, role, current).allowed !==
                resolveFeatureAccess(feature, role, proposed).allowed,
        );
        const deniedRoles = newlyDeniedRoles(feature, current, proposed);
        const dependentFeatures = FEATURE_DEFINITIONS.filter((definition) =>
            definition.dependencies.includes(feature),
        ).map((definition) => definition.key);
        let monitors = 0;
        let priceWatches = 0;

        if (deniedRoles.length > 0 && feature === "price_watch") {
            priceWatches = await client.price_watches.count({
                where: {
                    status: "active",
                    user: { role: { in: [...deniedRoles] } },
                },
            });
        } else if (deniedRoles.length > 0 && feature === "proxy_groups") {
            [monitors, priceWatches] = await Promise.all([
                client.monitors.count({
                    where: {
                        status: "active",
                        proxy_source: "group",
                        user: { role: { in: [...deniedRoles] } },
                    },
                }),
                client.price_watches.count({
                    where: {
                        status: "active",
                        user: { role: { in: [...deniedRoles] } },
                        schedule: { transport_kind: "proxy_group" },
                    },
                }),
            ]);
        } else if (deniedRoles.length > 0 && feature === "free_proxy_pool") {
            monitors = await client.monitors.count({
                where: {
                    status: "active",
                    proxy_source: "free",
                    user: { role: { in: [...deniedRoles] } },
                },
            });
        }

        impacts.push({
            feature,
            roles: [...roles],
            deniedRoles: [...deniedRoles],
            monitors,
            priceWatches,
            dependentFeatures,
        });
    }

    return impacts;
}

export async function getFeaturePoliciesAdminState() {
    await requireAdmin();
    const policies = await loadFeaturePolicies();
    return {
        definitions: FEATURE_DEFINITIONS,
        policies: FEATURE_KEYS.map((feature) => policies.get(feature)!),
    };
}

export async function previewFeaturePolicyChanges(input: FeaturePolicyDraft[]) {
    await requireAdmin();
    const drafts = normalizeDrafts(input);
    const current = await loadFeaturePolicies();
    return {
        impacts: await calculateImpacts(drafts, current),
    };
}

export async function applyFeaturePolicyChanges(input: FeaturePolicyDraft[]) {
    const adminUserId = await requireAdmin();
    const drafts = normalizeDrafts(input);

    const result = await db.$transaction(async (tx) => {
        const current = await loadFeaturePolicies(tx);
        for (const draft of drafts) {
            if (current.get(draft.feature)?.revision !== draft.revision) {
                throw new Error(
                    "Feature policies changed in another session. Reload and try again.",
                );
            }
        }
        const changed = drafts.filter((draft) => {
            const policy = current.get(draft.feature)!;
            return (
                policy.enabled !== draft.enabled ||
                USER_ROLES.some(
                    (role) => policy.roles[role] !== draft.roles[role],
                )
            );
        });
        const impacts = await calculateImpacts(drafts, current, tx);

        for (const draft of changed) {
            const updated = await tx.feature_policies.updateMany({
                where: {
                    feature: draft.feature,
                    revision: draft.revision,
                },
                data: {
                    enabled: draft.enabled,
                    free_enabled: draft.roles.free,
                    premium_enabled: draft.roles.premium,
                    admin_enabled: draft.roles.admin,
                    revision: { increment: 1 },
                    updated_at: new Date(),
                },
            });
            if (updated.count !== 1) {
                throw new Error(
                    "Feature policies changed in another session. Reload and try again.",
                );
            }
        }

        let pausedMonitors = 0;
        let pausedPriceWatches = 0;
        for (const impact of impacts) {
            if (impact.feature === "price_watch") {
                const result = await tx.price_watches.updateMany({
                    where: {
                        status: "active",
                        user: { role: { in: impact.deniedRoles } },
                    },
                    data: {
                        status: "paused",
                        stopped_reason: "feature_disabled",
                        armed_at: null,
                    },
                });
                pausedPriceWatches += result.count;
            } else if (impact.feature === "proxy_groups") {
                const monitorResult = await tx.monitors.updateMany({
                    where: {
                        status: "active",
                        proxy_source: "group",
                        user: { role: { in: impact.deniedRoles } },
                    },
                    data: { status: "paused" },
                });
                const watchResult = await tx.price_watches.updateMany({
                    where: {
                        status: "active",
                        user: { role: { in: impact.deniedRoles } },
                        schedule: { transport_kind: "proxy_group" },
                    },
                    data: {
                        status: "paused",
                        stopped_reason: "feature_disabled",
                        armed_at: null,
                    },
                });
                pausedMonitors += monitorResult.count;
                pausedPriceWatches += watchResult.count;
            } else if (impact.feature === "free_proxy_pool") {
                const result = await tx.monitors.updateMany({
                    where: {
                        status: "active",
                        proxy_source: "free",
                        user: { role: { in: impact.deniedRoles } },
                    },
                    data: { status: "paused" },
                });
                pausedMonitors += result.count;
            }
        }

        if (changed.length > 0) {
            await tx.audit_events.create({
                data: {
                    userId: adminUserId,
                    action: "admin.feature_policy_updated",
                    target_type: "feature_policy",
                    target_id: "feature_catalog",
                    metadata: {
                        changes: changed.map((draft) => ({
                            feature: draft.feature,
                            before: current.get(draft.feature),
                            after: {
                                enabled: draft.enabled,
                                roles: draft.roles,
                            },
                        })),
                        impacts,
                        pausedMonitors,
                        pausedPriceWatches,
                    },
                },
            });
        }

        return {
            changed: changed.length,
            impacts,
            pausedMonitors,
            pausedPriceWatches,
        };
    });

    revalidatePath("/", "layout");
    revalidatePath("/admin/features");
    revalidatePath("/admin/operations");
    return result;
}
