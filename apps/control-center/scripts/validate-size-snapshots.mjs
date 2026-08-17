import { promises as fs } from "node:fs";
import path from "node:path";

const regions = [
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
    "cz",
    "sk",
    "lt",
    "se",
    "dk",
    "ro",
    "hu",
    "hr",
    "fi",
];

const expectedGroupIds = new Set([
    4, 7, 14, 26, 27, 29, 30, 31, 32, 38, 43, 52, 53, 55, 56, 57, 59, 60, 61,
    62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 77, 79, 80, 81, 82,
    83, 84, 85,
]);

const datasetDir = path.resolve(process.cwd(), "data/vinted-sizes");
let referenceSizeIds;

for (const region of regions) {
    const file = path.join(datasetDir, region, "groups.json");
    const snapshot = JSON.parse(await fs.readFile(file, "utf8"));
    const groupIds = new Set(snapshot.groups.map((group) => group.id));
    const sizeIds = snapshot.groups.flatMap((group) =>
        group.sizes.map((size) => size.id),
    );

    if (snapshot.region !== region) {
        throw new Error(`${region}: snapshot region is ${snapshot.region}`);
    }
    if (
        groupIds.size !== expectedGroupIds.size ||
        [...expectedGroupIds].some((id) => !groupIds.has(id))
    ) {
        throw new Error(`${region}: public size group set is incomplete`);
    }
    if (snapshot.groups.some((group) => group.sizes.length === 0)) {
        throw new Error(`${region}: empty size groups must not be versioned`);
    }
    if (sizeIds.length !== 709 || new Set(sizeIds).size !== 709) {
        throw new Error(`${region}: expected 709 unique size IDs`);
    }
    const orderedSizeIds = [...sizeIds].sort((left, right) => left - right);
    if (!referenceSizeIds) {
        referenceSizeIds = orderedSizeIds;
    } else if (
        referenceSizeIds.some((id, index) => id !== orderedSizeIds[index])
    ) {
        throw new Error(
            `${region}: size IDs differ from the regional baseline`,
        );
    }
    for (const groupId of [74, 75, 77]) {
        if (!groupIds.has(groupId)) {
            throw new Error(`${region}: missing requested group ${groupId}`);
        }
    }
}

console.log(
    `Validated ${regions.length} regional snapshots with 41 groups and 709 sizes each.`,
);
