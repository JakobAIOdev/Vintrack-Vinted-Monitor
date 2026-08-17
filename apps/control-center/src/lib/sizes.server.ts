import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
    buildSizeSections,
    getSizeLabelsFromMap,
    MAX_MONITOR_SIZES,
    type SizeGroup,
    type SizeSection,
} from "@/lib/sizes";

type SizeSnapshot = {
    region: string;
    source: string;
    capturedAt: string;
    groups: SizeGroup[];
};

export type NormalizedSizeIds =
    | { ok: true; value: string | null }
    | { ok: false; message: string };

const snapshotCache = new Map<string, Promise<SizeSnapshot>>();
const labelMapCache = new Map<string, Promise<Record<string, string>>>();
const validIdCache = new Map<string, Promise<Set<string>>>();

async function getDatasetOutputDir() {
    const datasetDir = path.resolve(process.cwd(), "data/vinted-sizes");
    await fs.access(datasetDir);
    return datasetDir;
}

async function readSnapshot(region: string): Promise<SizeSnapshot> {
    const outputDir = await getDatasetOutputDir();
    const normalizedRegion = region.trim().toLowerCase();
    const candidates = [
        path.join(outputDir, normalizedRegion, "groups.json"),
        path.join(outputDir, "uk", "groups.json"),
    ];

    for (const candidate of candidates) {
        try {
            const content = await fs.readFile(candidate, "utf8");
            return JSON.parse(content) as SizeSnapshot;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw error;
        }
    }

    throw new Error("Unable to locate bundled Vinted size snapshots");
}

export async function getSizeSnapshotForRegion(
    region: string,
): Promise<SizeSnapshot> {
    const normalizedRegion = region.trim().toLowerCase();
    const cacheKey = normalizedRegion || "uk";
    const cached = snapshotCache.get(cacheKey);
    if (cached) return cached;

    const snapshot = readSnapshot(cacheKey);
    snapshotCache.set(cacheKey, snapshot);
    return snapshot;
}

export async function getSizeSectionsForRegion(
    region: string,
): Promise<SizeSection[]> {
    const snapshot = await getSizeSnapshotForRegion(region);
    return buildSizeSections(snapshot.groups);
}

async function getSizeLabelMapForRegion(
    region: string,
): Promise<Record<string, string>> {
    const normalizedRegion = region.trim().toLowerCase() || "uk";
    let labels = labelMapCache.get(normalizedRegion);
    if (!labels) {
        labels = getSizeSnapshotForRegion(normalizedRegion).then((snapshot) => {
            const result: Record<string, string> = Object.create(null);
            for (const group of snapshot.groups) {
                for (const size of group.sizes) {
                    result[String(size.id)] = `${group.label} · ${size.label}`;
                }
            }
            return result;
        });
        labelMapCache.set(normalizedRegion, labels);
    }
    return labels;
}

async function getValidSizeIdsForRegion(region: string): Promise<Set<string>> {
    const normalizedRegion = region.trim().toLowerCase() || "uk";
    let validIds = validIdCache.get(normalizedRegion);
    if (!validIds) {
        validIds = getSizeSnapshotForRegion(normalizedRegion).then(
            (snapshot) =>
                new Set(
                    snapshot.groups.flatMap((group) =>
                        group.sizes.map((size) => String(size.id)),
                    ),
                ),
        );
        validIdCache.set(normalizedRegion, validIds);
    }
    return validIds;
}

export async function getSizeLabelsForRegion(
    sizeIds: string | null | undefined,
    region: string,
): Promise<string[]> {
    return getSizeLabelsFromMap(
        sizeIds,
        await getSizeLabelMapForRegion(region),
    );
}

export async function normalizeSizeIdsForRegion(
    value: FormDataEntryValue | string | null | undefined,
    region: string,
): Promise<NormalizedSizeIds> {
    const raw = typeof value === "string" ? value : "";
    const values = raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

    if (values.some((id) => !/^\d+$/.test(id))) {
        return {
            ok: false,
            message: "Size filters must contain numeric Vinted IDs only.",
        };
    }

    const uniqueIds = [...new Set(values)];
    if (uniqueIds.length > MAX_MONITOR_SIZES) {
        return {
            ok: false,
            message: `Choose no more than ${MAX_MONITOR_SIZES} sizes per monitor.`,
        };
    }

    const validIds = await getValidSizeIdsForRegion(region);
    const invalidId = uniqueIds.find((id) => !validIds.has(id));
    if (invalidId) {
        return {
            ok: false,
            message: `Size ${invalidId} is not available for the selected Vinted region.`,
        };
    }

    return {
        ok: true,
        value: uniqueIds.length > 0 ? uniqueIds.join(",") : null,
    };
}
