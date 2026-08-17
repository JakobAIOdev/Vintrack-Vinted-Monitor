import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { MAX_MONITOR_SIZES } from "@/lib/sizes";
import { getSizeSectionsForRegion } from "@/lib/sizes.server";

export async function GET(request: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const region = searchParams.get("region") ?? "uk";
    const sections = await getSizeSectionsForRegion(region);

    return NextResponse.json({
        sections,
        maxSelected: MAX_MONITOR_SIZES,
    });
}
