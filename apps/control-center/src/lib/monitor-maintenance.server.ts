import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
    DEFAULT_MONITOR_MAINTENANCE,
    MONITOR_MAINTENANCE_SETTING_KEY,
    MONITOR_WORKER_RUNTIME_SETTING_KEY,
    parseMonitorMaintenance,
    parseMonitorWorkerRuntime,
} from "@/lib/monitor-maintenance";

type SettingClient = Prisma.TransactionClient | typeof db;

export async function getMonitorMaintenance(client: SettingClient = db) {
    try {
        const setting = await client.app_settings.findUnique({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            select: { value: true },
        });
        return parseMonitorMaintenance(setting?.value);
    } catch (error) {
        console.error(
            "[maintenance] failed to load monitor maintenance",
            error,
        );
        return DEFAULT_MONITOR_MAINTENANCE;
    }
}

export async function getMonitorWorkerRuntime(client: SettingClient = db) {
    const setting = await client.app_settings.findUnique({
        where: { key: MONITOR_WORKER_RUNTIME_SETTING_KEY },
        select: { value: true },
    });
    return parseMonitorWorkerRuntime(setting?.value);
}
