import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
    buildTelegramBotLink,
    createTelegramConnectCode,
    getTelegramBotUsername,
    getTelegramConnection,
} from "@/lib/telegram-connection";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const code = req.nextUrl.searchParams.get("code")?.trim().toUpperCase();
    if (!code) {
        return NextResponse.json({ error: "Missing code" }, { status: 400 });
    }
    const pending = await db.telegram_connect_codes.findFirst({
        where: { userId: session.user.id, code },
        select: { used_at: true, expires_at: true },
    });
    if (!pending) {
        return NextResponse.json(
            { error: "Connect code not found" },
            { status: 404 },
        );
    }
    return NextResponse.json({
        used: Boolean(pending.used_at),
        expired: pending.expires_at <= new Date(),
    });
}

export async function POST() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!process.env.TELEGRAM_BOT_TOKEN) {
        return NextResponse.json(
            { error: "Telegram bot token is not configured" },
            { status: 500 },
        );
    }
    if (!getTelegramBotUsername()) {
        return NextResponse.json(
            { error: "Telegram bot username is not configured" },
            { status: 500 },
        );
    }

    const code = createTelegramConnectCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    try {
        await db.telegram_connect_codes.updateMany({
            where: {
                userId: session.user.id,
                used_at: null,
                expires_at: { gt: new Date() },
            },
            data: { used_at: new Date() },
        });

        await db.telegram_connect_codes.create({
            data: {
                userId: session.user.id,
                code,
                expires_at: expiresAt,
            },
        });

        const connection = await getTelegramConnection(session.user.id);
        return NextResponse.json({
            code,
            expiresAt: expiresAt.toISOString(),
            botUsername: getTelegramBotUsername(),
            botLink: buildTelegramBotLink(code),
            connected: Boolean(connection),
        });
    } catch (error) {
        console.error("Failed to create Telegram connect code", error);
        return NextResponse.json(
            {
                error: "Failed to create Telegram connect code. Run the latest Prisma migration and restart the app.",
            },
            { status: 500 },
        );
    }
}
