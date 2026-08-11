import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
    MAX_ACTIVE_MEMBER_BRANDS,
    isValidMemberBrandId,
    MemberBrandLimitError,
    type VerifiedMemberBrand,
    upsertVerifiedMemberBrand,
} from "@/lib/member-brands.server";
import { REGIONS } from "@/lib/regions";
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";
const MAX_REQUEST_BYTES = 16 * 1024;
const SUPPORTED_REGIONS = new Set(REGIONS.map((region) => region.code));

function serializeBrand(brand: {
    brand_id: bigint;
    label: string;
    canonical_url: string;
    source_region: string;
    active: boolean;
}) {
    return {
        id: brand.brand_id.toString(),
        label: brand.label,
        canonical_url: brand.canonical_url,
        region: brand.source_region,
        source: "personal" as const,
        active: brand.active,
    };
}

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const selectedIds = (req.nextUrl.searchParams.get("ids") || "")
        .split(",")
        .filter(isValidMemberBrandId)
        .slice(0, MAX_ACTIVE_MEMBER_BRANDS)
        .map((id) => BigInt(id));

    const brands = await db.member_brands.findMany({
        where: {
            userId: session.user.id,
            OR: [
                { active: true },
                ...(selectedIds.length > 0
                    ? [{ brand_id: { in: selectedIds } }]
                    : []),
            ],
        },
        orderBy: { label: "asc" },
    });

    return NextResponse.json({ brands: brands.map(serializeBrand) });
}

export async function POST(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: { brand_url?: unknown; region?: unknown };
    try {
        const rawBody = await req.text();
        if (rawBody.length > MAX_REQUEST_BYTES) {
            return NextResponse.json(
                { error: "Request body too large" },
                { status: 413 },
            );
        }
        body = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const brandUrl =
        typeof body.brand_url === "string" ? body.brand_url.trim() : "";
    const region = typeof body.region === "string" ? body.region : "";
    if (!brandUrl || !SUPPORTED_REGIONS.has(region)) {
        return NextResponse.json(
            { error: "A Vinted brand URL and supported region are required" },
            { status: 400 },
        );
    }

    let resolved: VerifiedMemberBrand;
    try {
        const response = await fetch(`${API_URL}/api/catalog/brands/resolve`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": userId,
            },
            body: JSON.stringify({ brand_url: brandUrl, region }),
            cache: "no-store",
            signal: AbortSignal.timeout(12_000),
        });
        const data = await response.json();
        if (!response.ok) {
            return NextResponse.json(
                { error: data?.error || "Vinted brand validation failed" },
                {
                    status:
                        response.status >= 400 && response.status < 500
                            ? response.status
                            : 502,
                },
            );
        }
        resolved = data as VerifiedMemberBrand;
    } catch {
        return NextResponse.json(
            { error: "Vinted service unreachable" },
            { status: 502 },
        );
    }

    if (
        !isValidMemberBrandId(resolved.id) ||
        !resolved.label?.trim() ||
        !resolved.canonical_url?.startsWith("https://")
    ) {
        return NextResponse.json(
            { error: "Invalid response from Vinted service" },
            { status: 502 },
        );
    }

    try {
        const brand = await upsertVerifiedMemberBrand(
            db,
            userId,
            resolved,
            region,
        );

        return NextResponse.json({ brand: serializeBrand(brand) });
    } catch (error) {
        if (error instanceof MemberBrandLimitError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error("Failed to save personal brand", error);
        return NextResponse.json(
            { error: "Failed to save personal brand" },
            { status: 500 },
        );
    }
}
