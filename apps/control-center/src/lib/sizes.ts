export type SizeOption = {
    id: number;
    label: string;
};

export type SizeGroup = {
    id: number;
    label: string;
    sizes: SizeOption[];
};

export type SizeSectionKey =
    | "women"
    | "men"
    | "kids"
    | "accessories"
    | "home"
    | "pets";

export type SizeSection = {
    key: SizeSectionKey;
    label: string;
    groups: SizeGroup[];
};

export const MAX_MONITOR_SIZES = 100;
export const DEFAULT_SIZE_GROUP_ID = 14;

type SizeSectionDefinition = {
    key: SizeSectionKey;
    label: string;
    groupIds: readonly number[];
};

export const SIZE_SECTION_DEFINITIONS: readonly SizeSectionDefinition[] = [
    {
        key: "women",
        label: "Women & maternity",
        groupIds: [4, 7, 30, 53, 64, 72, 80, 81, 82, 83, 84, 85],
    },
    {
        key: "men",
        label: "Men",
        groupIds: [14, 38, 63, 73, 74, 75, 77],
    },
    {
        key: "kids",
        label: "Kids & baby",
        groupIds: [26, 27, 29, 31, 32, 43, 68, 70, 71],
    },
    {
        key: "accessories",
        label: "Accessories",
        groupIds: [52, 56, 60, 61, 62],
    },
    {
        key: "home",
        label: "Home",
        groupIds: [55, 59, 65, 66, 67, 69, 79],
    },
    {
        key: "pets",
        label: "Pets",
        groupIds: [57],
    },
];

export function buildSizeSections(groups: SizeGroup[]): SizeSection[] {
    const groupsById = new Map(groups.map((group) => [group.id, group]));

    return SIZE_SECTION_DEFINITIONS.map((section) => ({
        key: section.key,
        label: section.label,
        groups: section.groupIds
            .map((id) => groupsById.get(id))
            .filter((group): group is SizeGroup => Boolean(group)),
    })).filter((section) => section.groups.length > 0);
}

export function getSizeLabelsFromMap(
    sizeIds: string | null | undefined,
    labelsById: Record<string, string>,
): string[] {
    if (!sizeIds) return [];

    return sizeIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((id) => labelsById[id] ?? id);
}
