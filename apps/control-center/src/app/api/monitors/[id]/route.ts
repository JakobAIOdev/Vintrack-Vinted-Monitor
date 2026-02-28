import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const monitorId = parseInt(id);
  if (isNaN(monitorId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const monitor = await db.monitors.findFirst({
    where: { id: monitorId, userId: session.user.id },
    include: {
      proxy_group: { select: { name: true } },
    },
  });

  if (!monitor) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ monitor });
}
