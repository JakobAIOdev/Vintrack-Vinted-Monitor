import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
    buildCategoryLabelMap,
    getCategoryLabelsFromMap,
    normalizeCategoryTree,
    type CategoryNode,
    type RawCategoryTree,
} from "@/lib/categories";

const regionCache = new Map<string, Promise<CategoryNode[]>>();
const regionLabelMapCache = new Map<string, Promise<Record<string, string>>>();

const DATASET_FALLBACK_REGION_BY_REGION: Record<string, string> = {
    ie: "uk",
};

async function pathExists(targetPath: string) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function getDatasetOutputDir() {
    const datasetDir = path.resolve(process.cwd(), "data/vinted-categories");
    if (await pathExists(datasetDir)) {
        return datasetDir;
    }

    throw new Error("Unable to locate bundled Vinted category snapshots");
}

async function readRegionTree(region: string): Promise<RawCategoryTree> {
    const outputDir = await getDatasetOutputDir();
    const normalizedRegion = region.toLowerCase();
    const regionalFallback =
        DATASET_FALLBACK_REGION_BY_REGION[normalizedRegion];
    const candidates = [
        path.join(outputDir, normalizedRegion, "groups.json"),
        ...(regionalFallback
            ? [path.join(outputDir, regionalFallback, "groups.json")]
            : []),
        path.join(outputDir, "de", "groups.json"),
    ];

    for (const candidate of candidates) {
        if (await pathExists(candidate)) {
            const content = await fs.readFile(candidate, "utf8");
            return JSON.parse(content) as RawCategoryTree;
        }
    }

    return {};
}

export async function getCategoryTreeForRegion(
    region: string,
): Promise<CategoryNode[]> {
    const normalizedRegion = region.toLowerCase();
    const cached = regionCache.get(normalizedRegion);
    if (cached) {
        return cached;
    }

    const promise = readRegionTree(normalizedRegion).then((tree) =>
        normalizeCategoryTree(tree),
    );
    regionCache.set(normalizedRegion, promise);
    return promise;
}

export async function getCategoryLabelsForRegion(
    catalogIds: string | null | undefined,
    region: string,
): Promise<string[]> {
    if (!catalogIds) return [];

    const normalizedRegion = region.toLowerCase();
    let labelMapPromise = regionLabelMapCache.get(normalizedRegion);
    if (!labelMapPromise) {
        labelMapPromise = getCategoryTreeForRegion(normalizedRegion).then(
            buildCategoryLabelMap,
        );
        regionLabelMapCache.set(normalizedRegion, labelMapPromise);
    }

    const labelMap = await labelMapPromise;
    return getCategoryLabelsFromMap(catalogIds, labelMap);
}
