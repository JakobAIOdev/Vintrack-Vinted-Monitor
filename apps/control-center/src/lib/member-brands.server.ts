import type { PrismaClient } from "@prisma/client";

export const MAX_ACTIVE_MEMBER_BRANDS = 500;
const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");

export function isValidMemberBrandId(value: string): boolean {
    if (!/^\d+$/.test(value)) return false;
    try {
        const id = BigInt(value);
        return id > BigInt(0) && id <= MAX_POSTGRES_BIGINT;
    } catch {
        return false;
    }
}

export class MemberBrandLimitError extends Error {
    constructor() {
        super("You can have at most 500 active personal brands");
        this.name = "MemberBrandLimitError";
    }
}

export type VerifiedMemberBrand = {
    id: string;
    label: string;
    canonical_url: string;
};

export async function upsertVerifiedMemberBrand(
    db: PrismaClient,
    userId: string,
    resolved: VerifiedMemberBrand,
    region: string,
    maxActiveBrands = MAX_ACTIVE_MEMBER_BRANDS,
) {
    if (!isValidMemberBrandId(resolved.id)) {
        throw new Error("Invalid verified brand ID");
    }
    const brandId = BigInt(resolved.id);

    return db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
        const existing = await tx.member_brands.findUnique({
            where: { userId_brand_id: { userId, brand_id: brandId } },
        });

        if (!existing?.active) {
            const activeCount = await tx.member_brands.count({
                where: { userId, active: true },
            });
            if (activeCount >= maxActiveBrands) {
                throw new MemberBrandLimitError();
            }
        }

        return tx.member_brands.upsert({
            where: { userId_brand_id: { userId, brand_id: brandId } },
            create: {
                userId,
                brand_id: brandId,
                label: resolved.label.trim(),
                canonical_url: resolved.canonical_url,
                source_region: region,
                active: true,
            },
            update: {
                label: resolved.label.trim(),
                canonical_url: resolved.canonical_url,
                source_region: region,
                active: true,
            },
        });
    });
}
