export const INACTIVE_MEMBER_POLICY_SETTING_KEY =
    "inactive_member_monitor_policy";
export const INACTIVE_MEMBER_RUNTIME_SETTING_KEY =
    "inactive_member_monitor_runtime";

export const INACTIVITY_DURATION_UNITS = ["days", "weeks", "months"] as const;
export const INACTIVITY_MONITOR_SCOPES = ["free_proxy", "all"] as const;
export const INACTIVITY_ROLES = ["free", "premium"] as const;

export type InactivityDurationUnit = (typeof INACTIVITY_DURATION_UNITS)[number];
export type InactivityMonitorScope = (typeof INACTIVITY_MONITOR_SCOPES)[number];
export type InactivityRole = (typeof INACTIVITY_ROLES)[number];

export type InactiveMemberPolicy = {
    enabled: boolean;
    revision: string;
    duration: number;
    durationUnit: InactivityDurationUnit;
    durationDays: number;
    monitorScope: InactivityMonitorScope;
    roles: InactivityRole[];
    enabledAt: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
};

export type InactiveMemberRuntime = {
    heartbeatAt: string;
    policyRevision: string;
    lastEvaluatedAt: string;
    pausedMemberCount: number;
    pausedMonitorCount: number;
};

export type InactiveMemberPolicyInput = Pick<
    InactiveMemberPolicy,
    "enabled" | "duration" | "durationUnit" | "monitorScope" | "roles"
>;

export const DEFAULT_INACTIVE_MEMBER_POLICY: InactiveMemberPolicy = {
    enabled: false,
    revision: "inactive-member-policy-disabled-v1",
    duration: 1,
    durationUnit: "weeks",
    durationDays: 7,
    monitorScope: "free_proxy",
    roles: ["free"],
    enabledAt: null,
    updatedAt: null,
    updatedBy: null,
};

const MAX_DURATION_DAYS = 5 * 365;

export function normalizeInactiveDurationDays(
    duration: number,
    unit: InactivityDurationUnit,
) {
    const multiplier = unit === "months" ? 30 : unit === "weeks" ? 7 : 1;
    return duration * multiplier;
}

export function validateInactiveMemberPolicyInput(
    input: InactiveMemberPolicyInput,
): InactiveMemberPolicyInput & { durationDays: number } {
    if (!Number.isInteger(input.duration) || input.duration <= 0) {
        throw new Error("Duration must be a positive whole number");
    }
    if (!INACTIVITY_DURATION_UNITS.includes(input.durationUnit)) {
        throw new Error("Invalid duration unit");
    }
    const durationDays = normalizeInactiveDurationDays(
        input.duration,
        input.durationUnit,
    );
    if (durationDays < 1 || durationDays > MAX_DURATION_DAYS) {
        throw new Error("Duration must be between 1 day and 5 years");
    }
    if (!INACTIVITY_MONITOR_SCOPES.includes(input.monitorScope)) {
        throw new Error("Invalid monitor scope");
    }
    const roles = [...new Set(input.roles)].filter((role) =>
        INACTIVITY_ROLES.includes(role),
    );
    if (input.enabled && roles.length === 0) {
        throw new Error("Select at least one member role");
    }
    if (roles.length !== input.roles.length) {
        throw new Error("Invalid member role");
    }
    return { ...input, roles, durationDays };
}

function validIso(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function parseInactiveMemberPolicy(
    value: string | null | undefined,
): InactiveMemberPolicy {
    if (!value) return { ...DEFAULT_INACTIVE_MEMBER_POLICY };
    try {
        const raw = JSON.parse(value) as Partial<InactiveMemberPolicy>;
        const normalized = validateInactiveMemberPolicyInput({
            enabled: raw.enabled === true,
            duration: raw.duration as number,
            durationUnit: raw.durationUnit as InactivityDurationUnit,
            monitorScope: raw.monitorScope as InactivityMonitorScope,
            roles: raw.roles as InactivityRole[],
        });
        if (typeof raw.revision !== "string" || !raw.revision.trim()) {
            return { ...DEFAULT_INACTIVE_MEMBER_POLICY };
        }
        if (raw.enabled && !validIso(raw.enabledAt)) {
            return { ...DEFAULT_INACTIVE_MEMBER_POLICY };
        }
        return {
            ...normalized,
            revision: raw.revision.trim(),
            enabledAt: validIso(raw.enabledAt) ? raw.enabledAt : null,
            updatedAt: validIso(raw.updatedAt) ? raw.updatedAt : null,
            updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : null,
        };
    } catch {
        return { ...DEFAULT_INACTIVE_MEMBER_POLICY };
    }
}

export function parseInactiveMemberRuntime(
    value: string | null | undefined,
): InactiveMemberRuntime | null {
    if (!value) return null;
    try {
        const raw = JSON.parse(value) as Partial<InactiveMemberRuntime>;
        if (
            !validIso(raw.heartbeatAt) ||
            !validIso(raw.lastEvaluatedAt) ||
            typeof raw.policyRevision !== "string" ||
            !Number.isInteger(raw.pausedMemberCount) ||
            !Number.isInteger(raw.pausedMonitorCount)
        ) {
            return null;
        }
        return raw as InactiveMemberRuntime;
    } catch {
        return null;
    }
}

export function inactivePolicyRuntimeStatus(
    policy: InactiveMemberPolicy,
    runtime: InactiveMemberRuntime | null,
    now = Date.now(),
) {
    if (!policy.enabled) return "disabled" as const;
    if (
        !runtime ||
        runtime.policyRevision !== policy.revision ||
        now - Date.parse(runtime.heartbeatAt) > 150_000
    ) {
        return "confirmation_pending" as const;
    }
    return "active" as const;
}
