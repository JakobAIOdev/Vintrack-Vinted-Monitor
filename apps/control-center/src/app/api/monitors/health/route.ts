import { NextResponse } from "next/server";
import Redis from "ioredis";
import { auth } from "@/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export type MonitorHealth = {
  monitor_id: number;
  total_checks: number;
  total_errors: number;
  consecutive_errors: number;
  last_error?: string;
  updated_at: string;
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const userMonitors = await db.monitors.findMany({
    where: { userId: session.user.id, status: "active" },
    select: { id: true },
  });

  if (userMonitors.length === 0) {
    return NextResponse.json({});
  }

  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

  try {
    const pipe = redis.pipeline();
    for (const m of userMonitors) {
      pipe.get(`monitor:health:${m.id}`);
    }
    const results = await pipe.exec();

    const health: Record<number, MonitorHealth> = {};
    if (results) {
      for (let i = 0; i < userMonitors.length; i++) {
        const [err, val] = results[i];
        if (!err && val && typeof val === "string") {
          try {
            health[userMonitors[i].id] = JSON.parse(val);
          } catch {}
        }
      }
    }

    return NextResponse.json(health);
  } finally {
    redis.quit();
  }
}
