import "server-only";

import { cache } from "react";
import { db } from "@/lib/db";
import {
    FEATURE_KEYS,
    defaultFeaturePolicy,
    isFeatureKey,
    resolveFeatureAccess,
    type FeatureAccessResult,
    type FeatureKey,
    type FeaturePolicy,
} from "@/lib/features";

type FeaturePolicyClient = Pick<typeof db, "feature_policies">;

export class FeatureUnavailableError extends Error {
    readonly access: Exclude<FeatureAccessResult, { allowed: true }>;

    constructor(access: Exclude<FeatureAccessResult, { allowed: true }>) {
        super(`Feature unavailable: ${access.feature} (${access.reason})`);
        this.name = "FeatureUnavailableError";
        this.access = access;
    }
}

export async function loadFeaturePolicies(
    client: FeaturePolicyClient = db,
): Promise<Map<FeatureKey, FeaturePolicy>> {
    const rows = await client.feature_policies.findMany();
    const policies = new Map<FeatureKey, FeaturePolicy>(
        FEATURE_KEYS.map((feature) => [feature, defaultFeaturePolicy(feature)]),
    );
    for (const row of rows) {
        if (!isFeatureKey(row.feature)) continue;
        policies.set(row.feature, {
            feature: row.feature,
            enabled: row.enabled,
            roles: {
                free: row.free_enabled,
                premium: row.premium_enabled,
                admin: row.admin_enabled,
            },
            revision: row.revision,
            updatedAt: row.updated_at.toISOString(),
        });
    }
    return policies;
}

export const getFeaturePolicies = cache(loadFeaturePolicies);

export async function getFeatureAccessForUser(
    feature: FeatureKey,
    userId: string,
    client: FeaturePolicyClient & Pick<typeof db, "user"> = db,
) {
    const user = await client.user.findUnique({
        where: { id: userId },
        select: { role: true },
    });
    return getFeatureAccess(feature, user?.role, client);
}

export async function requireFeatureAccessForUser(
    feature: FeatureKey,
    userId: string,
    client: FeaturePolicyClient & Pick<typeof db, "user"> = db,
) {
    const access = await getFeatureAccessForUser(feature, userId, client);
    if (!access.allowed) throw new FeatureUnavailableError(access);
    return access;
}

export async function getFeatureAccess(
    feature: FeatureKey,
    role: string | null | undefined,
    client: FeaturePolicyClient = db,
) {
    return resolveFeatureAccess(
        feature,
        role,
        await loadFeaturePolicies(client),
    );
}

export async function requireFeatureAccess(
    feature: FeatureKey,
    role: string | null | undefined,
    client: FeaturePolicyClient = db,
) {
    const access = await getFeatureAccess(feature, role, client);
    if (!access.allowed) throw new FeatureUnavailableError(access);
    return access;
}

export async function getFeatureCapabilities(role: string | null | undefined) {
    const policies = await getFeaturePolicies();
    return Object.fromEntries(
        FEATURE_KEYS.map((feature) => [
            feature,
            resolveFeatureAccess(feature, role, policies),
        ]),
    ) as Record<FeatureKey, FeatureAccessResult>;
}

export async function guardApiFeature(userId: string, feature: FeatureKey) {
    const access = await getFeatureAccessForUser(feature, userId);
    return access.allowed ? null : featureUnavailableResponse(access);
}

export function featureUnavailableResponse(
    access: Exclude<FeatureAccessResult, { allowed: true }>,
) {
    return Response.json(
        {
            code: "FEATURE_UNAVAILABLE",
            feature: access.feature,
            reason: access.reason,
            ...(access.dependency ? { dependency: access.dependency } : {}),
        },
        { status: 403 },
    );
}
