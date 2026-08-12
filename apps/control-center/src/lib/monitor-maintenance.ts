import type { MemberAnnouncement } from "@/lib/member-announcement";

export const MONITOR_MAINTENANCE_SETTING_KEY = "monitor_maintenance";
export const MONITOR_WORKER_RUNTIME_SETTING_KEY = "monitor_worker_runtime";
export const MONITOR_MAINTENANCE_LOCK_KEY =
    "vintrack:global-monitor-maintenance";

export const DEFAULT_MONITOR_MAINTENANCE_MESSAGE =
    "We’re performing maintenance to improve Vintrack. All monitors are safely paused and will resume automatically when maintenance is complete.";

export type MonitorMaintenance = {
    enabled: boolean;
    revision: string;
    message: string;
    estimatedEndAt: string | null;
    enabledAt: string | null;
    enabledBy: string | null;
    updatedAt: string | null;
};

export type MonitorWorkerRuntime = {
    heartbeatAt: string;
    maintenanceRevision: string;
    runningMonitorTasks: number;
    runningDiscoveryTasks: number;
};

export type MonitorMaintenanceStatus =
    | "off"
    | "draining"
    | "active"
    | "confirmation_pending";

export const DEFAULT_MONITOR_MAINTENANCE: MonitorMaintenance = {
    enabled: false,
    revision: "maintenance-disabled-v1",
    message: DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
    estimatedEndAt: null,
    enabledAt: null,
    enabledBy: null,
    updatedAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalIsoDate(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") throw new Error("Invalid date");
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid date");
    return date.toISOString();
}

export function validateMonitorMaintenanceInput(
    input: {
        message: unknown;
        estimatedEndAt?: unknown;
    },
    options?: { requireFutureEta?: boolean; now?: Date },
) {
    if (typeof input.message !== "string") {
        throw new Error("Maintenance message must be a string");
    }
    const message = input.message.trim();
    if (!message) throw new Error("Maintenance message is required");
    if (message.length > 300) {
        throw new Error("Maintenance message must be 300 characters or fewer");
    }

    const estimatedEndAt = optionalIsoDate(input.estimatedEndAt);
    if (
        options?.requireFutureEta !== false &&
        estimatedEndAt &&
        new Date(estimatedEndAt).getTime() <=
            (options?.now ?? new Date()).getTime()
    ) {
        throw new Error("Estimated end time must be in the future");
    }

    return { message, estimatedEndAt };
}

export function parseMonitorMaintenance(
    value: string | null | undefined,
): MonitorMaintenance {
    if (!value) return DEFAULT_MONITOR_MAINTENANCE;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!isRecord(parsed)) return DEFAULT_MONITOR_MAINTENANCE;
        if (
            typeof parsed.enabled !== "boolean" ||
            typeof parsed.revision !== "string" ||
            !parsed.revision.trim()
        ) {
            return DEFAULT_MONITOR_MAINTENANCE;
        }
        const normalized = validateMonitorMaintenanceInput(
            {
                message: parsed.message,
                estimatedEndAt: parsed.estimatedEndAt,
            },
            { requireFutureEta: false },
        );
        return {
            enabled: parsed.enabled,
            revision: parsed.revision.trim(),
            ...normalized,
            enabledAt: optionalIsoDate(parsed.enabledAt),
            enabledBy:
                typeof parsed.enabledBy === "string" ? parsed.enabledBy : null,
            updatedAt: optionalIsoDate(parsed.updatedAt ?? parsed.enabledAt),
        };
    } catch {
        return DEFAULT_MONITOR_MAINTENANCE;
    }
}

export function parseMonitorWorkerRuntime(
    value: string | null | undefined,
): MonitorWorkerRuntime | null {
    if (!value) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!isRecord(parsed)) return null;
        const heartbeatAt = optionalIsoDate(parsed.heartbeatAt);
        if (
            !heartbeatAt ||
            typeof parsed.maintenanceRevision !== "string" ||
            typeof parsed.runningMonitorTasks !== "number" ||
            !Number.isInteger(parsed.runningMonitorTasks) ||
            parsed.runningMonitorTasks < 0 ||
            typeof parsed.runningDiscoveryTasks !== "number" ||
            !Number.isInteger(parsed.runningDiscoveryTasks) ||
            parsed.runningDiscoveryTasks < 0
        ) {
            return null;
        }
        return {
            heartbeatAt,
            maintenanceRevision: parsed.maintenanceRevision,
            runningMonitorTasks: parsed.runningMonitorTasks,
            runningDiscoveryTasks: parsed.runningDiscoveryTasks,
        };
    } catch {
        return null;
    }
}

export function getMonitorMaintenanceStatus(
    maintenance: MonitorMaintenance,
    runtime: MonitorWorkerRuntime | null,
    now = new Date(),
): MonitorMaintenanceStatus {
    if (!maintenance.enabled) return "off";
    if (
        !runtime ||
        runtime.maintenanceRevision !== maintenance.revision ||
        now.getTime() - new Date(runtime.heartbeatAt).getTime() > 15_000
    ) {
        return "confirmation_pending";
    }
    return runtime.runningMonitorTasks + runtime.runningDiscoveryTasks === 0
        ? "active"
        : "draining";
}

export function getMaintenanceAnnouncement(
    maintenance: MonitorMaintenance,
): MemberAnnouncement {
    const eta = maintenance.estimatedEndAt
        ? ` Estimated completion: ${new Intl.DateTimeFormat("en", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "UTC",
          }).format(new Date(maintenance.estimatedEndAt))} UTC.`
        : "";
    return {
        enabled: maintenance.enabled,
        revision: `maintenance:${maintenance.revision}`,
        variant: "critical",
        title: "Vintrack is currently undergoing maintenance",
        message: `${maintenance.message}${eta}`,
        cta: null,
        dismissible: false,
        audiences: ["free", "premium", "admin"],
        placements: [
            "monitors",
            "live_feed",
            "member_tools",
            "proxy_groups",
            "guide",
            "admin",
        ],
        startsAt: null,
        endsAt: null,
    };
}
