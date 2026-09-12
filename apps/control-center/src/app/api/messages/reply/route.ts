import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { logAuditEvent } from "@/lib/audit";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function POST(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const featureDenied = await guardApiFeature(session.user.id, "chats");
    if (featureDenied) return featureDenied;

    try {
        const body = await req.text();
        const parsed = JSON.parse(body || "{}") as {
            conversation_id?: unknown;
        };
        const res = await fetch(`${API_URL}/api/messages/reply`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": session.user.id,
            },
            body,
        });
        const data = await res.json();
        await logAuditEvent({
            userId: session.user.id,
            action: "message.reply",
            targetType: "conversation",
            targetId:
                typeof parsed.conversation_id === "number" ||
                typeof parsed.conversation_id === "string"
                    ? parsed.conversation_id
                    : null,
            status: res.ok ? "success" : "failed",
            metadata: { http_status: res.status },
        });
        return NextResponse.json(data, { status: res.status });
    } catch {
        await logAuditEvent({
            userId: session.user.id,
            action: "message.reply",
            targetType: "conversation",
            status: "failed",
            metadata: { error: "vinted_service_unreachable" },
        });
        return NextResponse.json(
            { error: "Vinted service unreachable" },
            { status: 502 },
        );
    }
}
