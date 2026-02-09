import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const monitorId = parseInt(id);
  
  if (isNaN(monitorId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

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
