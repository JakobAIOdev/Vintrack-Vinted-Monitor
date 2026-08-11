import { auth } from "@/auth";
import { db } from "@/lib/db";
import { isValidMemberBrandId } from "@/lib/member-brands.server";
import { NextResponse } from "next/server";

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ brandId: string }> },
) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { brandId } = await params;
    if (!isValidMemberBrandId(brandId)) {
        return NextResponse.json(
            { error: "Invalid brand ID" },
            { status: 400 },
        );
    }

    await db.member_brands.updateMany({
        where: {
            userId: session.user.id,
            brand_id: BigInt(brandId),
        },
        data: { active: false },
    });

    return NextResponse.json({ success: true });
}
