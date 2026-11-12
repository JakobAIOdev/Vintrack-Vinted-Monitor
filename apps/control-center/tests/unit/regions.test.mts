import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
    getRegionCurrencyCode,
    getRegionDomain,
    getRegionFlags,
    getRegionLabel,
    getRegionTimezone,
    getStatusLocaleForRegion,
    REGIONS,
} from "../../src/lib/regions.ts";

type SizeSnapshot = {
    region: string;
    source: string;
    groups: {
        id: number;
        label: string;
        sizes: { id: number; label: string }[];
    }[];
};

type CategoryNode = {
    id: number;
    slug: string;
    children: Record<string, CategoryNode>;
};

async function readDataset<T>(dataset: string, region: string): Promise<T> {
    const file = path.resolve(
        process.cwd(),
        "data",
        dataset,
        region,
        "groups.json",
    );
    return JSON.parse(await readFile(file, "utf8")) as T;
}

function collectCategories(
    tree: Record<string, CategoryNode>,
    parentPath: string[] = [],
    found = new Map<number, string>(),
) {
    for (const [label, node] of Object.entries(tree)) {
        const nodePath = [...parentPath, label];
        assert.equal(
            found.has(node.id),
            false,
            `duplicate category ${node.id}`,
        );
        found.set(node.id, nodePath.join(" › "));
        collectCategories(node.children, nodePath, found);
    }
    return found;
}

test("the United States is a monitor region on vinted.com priced in USD", () => {
    const region = REGIONS.find((candidate) => candidate.code === "us");
    assert.deepEqual(region, {
        code: "us",
        label: "United States",
        flag: "🇺🇸",
        domain: "vinted.com",
        currencyCode: "USD",
    });
    assert.equal(getRegionDomain("us"), "vinted.com");
    assert.equal(getRegionCurrencyCode("us"), "USD");
    assert.equal(getRegionLabel("us"), "🇺🇸 United States");
    assert.deepEqual(getRegionFlags("de,us"), ["🇩🇪", "🇺🇸"]);
    assert.equal(getStatusLocaleForRegion("us"), "en");
});

test("every region has a unique code and domain and a usable timezone", () => {
    assert.equal(
        new Set(REGIONS.map((region) => region.code)).size,
        REGIONS.length,
    );
    assert.equal(
        new Set(REGIONS.map((region) => region.domain)).size,
        REGIONS.length,
    );
    for (const region of REGIONS) {
        const timezone = getRegionTimezone(region.code);
        assert.doesNotThrow(
            () => new Intl.DateTimeFormat("en-US", { timeZone: timezone }),
            region.code,
        );
    }
    assert.equal(getRegionTimezone("us"), "America/New_York");
});

test("the account page keeps offering the same twelve linkable regions", () => {
    assert.deepEqual(
        REGIONS.slice(0, 12).map((region) => region.code),
        [
            "de",
            "fr",
            "it",
            "es",
            "nl",
            "pl",
            "pt",
            "be",
            "at",
            "lu",
            "uk",
            "ie",
        ],
    );
});

test("every region ships its own size snapshot", async () => {
    for (const region of REGIONS) {
        const snapshot = await readDataset<SizeSnapshot>(
            "vinted-sizes",
            region.code,
        );
        assert.equal(snapshot.region, region.code);
        assert.equal(
            new URL(snapshot.source).hostname,
            `www.${region.domain}`,
            region.code,
        );
    }
});

test("US sizes keep the shared IDs but carry US labels", async () => {
    const us = await readDataset<SizeSnapshot>("vinted-sizes", "us");
    const uk = await readDataset<SizeSnapshot>("vinted-sizes", "uk");
    const label = (snapshot: SizeSnapshot, groupId: number, sizeId: number) =>
        snapshot.groups
            .find((group) => group.id === groupId)
            ?.sizes.find((size) => size.id === sizeId)?.label;

    assert.equal(label(us, 38, 784), "9");
    assert.equal(label(uk, 38, 784), "8");
    assert.equal(label(us, 4, 3), "S / US 4-6");
    assert.equal(
        us.groups.find((group) => group.id === 77)?.label,
        "Men's pants",
    );
});

test("the US category snapshot is the US tree, not a European fallback", async () => {
    const tree = await readDataset<Record<string, CategoryNode>>(
        "vinted-categories",
        "us",
    );
    assert.deepEqual(Object.keys(tree), [
        "Women",
        "Men",
        "Designer",
        "Kids",
        "Home",
        "Electronics",
        "Books & Media",
        "Hobbies & collectibles",
        "Sports",
    ]);

    const categories = collectCategories(tree);
    assert.equal(categories.get(5), "Men");
    assert.equal(categories.get(1231), "Men › Shoes");
    // The UK tree calls this category "Jumpers".
    assert.equal(
        categories.get(1917),
        "Women › Clothing › Jumpers & sweaters › Sweaters",
    );
    // Vinted titles this node like its sibling on the US site; the snapshot
    // keeps both selectable under distinct labels.
    assert.equal(
        categories.get(3901),
        "Home › Tools & DIY › Power tools › Grinders",
    );
    assert.equal(
        categories.get(3902),
        "Home › Tools & DIY › Power tools › Power tool combo kits",
    );
});
