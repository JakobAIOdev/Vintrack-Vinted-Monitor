import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userMonitors = await db.monitors.findMany({
      where: { userId: session.user.id },
      select: { id: true },
    });

    const monitorIds = userMonitors.map((m) => m.id);

    if (monitorIds.length === 0) {
      return NextResponse.json([]);
    }

    const items = await db.items.findMany({
      where: {
        monitor_id: { in: monitorIds },
      },
      orderBy: { found_at: "desc" },
      take: 100,
      select: {
        id: true,
        monitor_id: true,
        title: true,
        price: true,
        total_price: true,
        size: true,
        condition: true,
        url: true,
        image_url: true,
        found_at: true,
        location: true,
        rating: true,
        seller_id: true,
        monitors: {
          select: { query: true },
        },
      },
    });

    const safeItems = items.map(({ monitors, ...item }) => ({
      ...item,
      id: item.id.toString(),
      seller_id: item.seller_id?.toString() || null,
      monitor_name: monitors?.query || "Unknown",
    }));

    return NextResponse.json(safeItems);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
