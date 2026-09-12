import "server-only";

import { db } from "@/lib/db";
import {
    DEFAULT_PRICE_WATCH_POLICY,
    DEFAULT_WORKER_POLICY,
    parseFreeProxyPolicy,
    parsePriceWatchPolicy,
    parseWorkerPolicy,
    RUNTIME_POLICY_KEYS,
    type FreeProxyPolicy,
    type PriceWatchPolicy,
    type VersionedPolicy,
    type WorkerPolicy,
} from "@/lib/runtime-policies";

async function readDocument(key: string) {
    return db.app_settings.findUnique({
        where: { key },
        select: { value: true },
    });
}

function legacyWarning(key: string) {
    console.warn(
        `[config] ${key} is using deprecated scalar settings; save it once to migrate to the versioned policy document`,
    );
}

export async function readPriceWatchPolicy(): Promise<PriceWatchPolicy> {
    const document = await readDocument(RUNTIME_POLICY_KEYS.priceWatch);
    const parsed = parsePriceWatchPolicy(document?.value);
    if (parsed) return parsed;

    legacyWarning(RUNTIME_POLICY_KEYS.priceWatch);
    const rows = await db.app_settings.findMany({
        where: {
            key: {
                in: [
                    "price_watch_shared_min_interval_seconds",
                    "price_watch_personal_min_interval_seconds",
                    "price_watch_shared_max_rpm",
                    "price_watch_personal_max_rpm_per_proxy",
                ],
            },
        },
        select: { key: true, value: true },
    });
    const values = Object.fromEntries(
        rows.map((row) => [row.key, Number(row.value)]),
    );
    return {
        ...DEFAULT_PRICE_WATCH_POLICY,
        sharedMinimumSeconds:
            values.price_watch_shared_min_interval_seconds ||
            DEFAULT_PRICE_WATCH_POLICY.sharedMinimumSeconds,
        personalMinimumSeconds:
            values.price_watch_personal_min_interval_seconds ||
            DEFAULT_PRICE_WATCH_POLICY.personalMinimumSeconds,
        sharedMaxRpm:
            values.price_watch_shared_max_rpm ||
            DEFAULT_PRICE_WATCH_POLICY.sharedMaxRpm,
        personalMaxRpmPerProxy:
            values.price_watch_personal_max_rpm_per_proxy ||
            DEFAULT_PRICE_WATCH_POLICY.personalMaxRpmPerProxy,
    };
}

export async function readFreeProxyPolicy(): Promise<FreeProxyPolicy | null> {
    const document = await readDocument(RUNTIME_POLICY_KEYS.freeProxy);
    const parsed = parseFreeProxyPolicy(document?.value);
    if (!parsed) legacyWarning(RUNTIME_POLICY_KEYS.freeProxy);
    return parsed;
}

export async function readWorkerPolicy(): Promise<WorkerPolicy> {
    const document = await readDocument(RUNTIME_POLICY_KEYS.worker);
    return parseWorkerPolicy(document?.value) ?? DEFAULT_WORKER_POLICY;
}

export async function writePolicyDocument<T extends VersionedPolicy>(
    key: string,
    policy: Omit<T, "version" | "revision">,
) {
    return db.$transaction(async (tx) => {
        const current = await tx.app_settings.findUnique({
            where: { key },
            select: { value: true },
        });
        let revision = 0;
        try {
            const parsed = JSON.parse(
                current?.value ?? "{}",
            ) as Partial<VersionedPolicy>;
            revision = Number.isInteger(parsed.revision)
                ? Number(parsed.revision)
                : 0;
        } catch {
            revision = 0;
        }
        const next = {
            ...policy,
            version: 1 as const,
            revision: revision + 1,
        } as T;
        await tx.app_settings.upsert({
            where: { key },
            create: { key, value: JSON.stringify(next) },
            update: { value: JSON.stringify(next) },
        });
        return next;
    });
}
