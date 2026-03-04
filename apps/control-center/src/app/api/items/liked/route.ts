import { auth } from "@/auth";
import { NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ item_ids: [] });
  }

  try {
    const res = await fetch(`${API_URL}/api/items/liked`, {
      headers: { "X-User-ID": session.user.id },
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ item_ids: [] });
  }
}
