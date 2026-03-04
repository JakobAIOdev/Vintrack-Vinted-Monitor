import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

async function proxyRequest(req: NextRequest, subPath: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = `${API_URL}/api/account/${subPath}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-ID": session.user.id,
  };

  const options: RequestInit = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.text();
    if (body) options.body = body;
  }

  try {
    const res = await fetch(url, options);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "Vinted service unreachable" },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest) {
  return proxyRequest(req, "status");
}

export async function POST(req: NextRequest) {
  return proxyRequest(req, "link");
}

export async function DELETE(req: NextRequest) {
  return proxyRequest(req, "unlink");
}
