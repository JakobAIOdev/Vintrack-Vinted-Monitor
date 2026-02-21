import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const monitorId = parseInt(id);
  
  if (isNaN(monitorId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const monitor = await db.monitors.findFirst({
    where: { id: monitorId, userId: session.user.id },
  });

  if (!monitor) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const items = await db.items.findMany({
      where: { monitor_id: monitorId },
      orderBy: { found_at: "desc" },
      take: 50,
    });

    const safeItems = items.map(item => ({
      ...item,
      id: item.id.toString(),
    }));

    return NextResponse.json(safeItems);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
