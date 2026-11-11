import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { escapeTelegramHTML, sendTelegramMessage } from "@/lib/telegram";

type TelegramChat = {
    id: number | string;
    type?: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
};

type TelegramMessage = {
    text?: string;
    chat?: TelegramChat;
    from?: {
        username?: string;
        first_name?: string;
        last_name?: string;
    };
};

type TelegramUpdate = {
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
};

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    // Without a secret anyone could post a forged update and bind a chat of
    // their choosing to a member's connect code, so an unset secret rejects
    // every update instead of accepting all of them.
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!secret) {
        return NextResponse.json(
            { error: "Telegram webhook secret is not configured" },
            { status: 503 },
        );
    }
    if (
        !secretMatches(
            req.headers.get("x-telegram-bot-api-secret-token"),
            secret,
        )
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let update: TelegramUpdate;
    try {
        update = (await req.json()) as TelegramUpdate;
    } catch {
        return NextResponse.json({ ok: true });
    }

    const message = update.message || update.edited_message;
    const text = message?.text?.trim();
    const chat = message?.chat;
    if (!text || !chat) {
        return NextResponse.json({ ok: true });
    }

    const code = extractConnectCode(text);
    if (!code) {
        return NextResponse.json({ ok: true });
    }

    const pending = await db.telegram_connect_codes.findFirst({
        where: {
            code,
            used_at: null,
            expires_at: { gt: new Date() },
        },
        select: { id: true, userId: true },
    });

    if (!pending) {
        await sendTelegramMessage(
            String(chat.id),
            "Vintrack: This connect code is invalid or expired. Please create a new code in the dashboard.",
        );
        return NextResponse.json({ ok: true });
    }

    const chatTitle = getChatTitle(chat, message);
    await db.$transaction([
        db.telegram_connections.upsert({
            where: { userId: pending.userId },
            update: {
                chat_id: String(chat.id),
                chat_type: chat.type || null,
                chat_title: chatTitle,
                username: chat.username || message.from?.username || null,
            },
            create: {
                userId: pending.userId,
                chat_id: String(chat.id),
                chat_type: chat.type || null,
                chat_title: chatTitle,
                username: chat.username || message.from?.username || null,
            },
        }),
        db.telegram_connect_codes.update({
            where: { id: pending.id },
            data: { used_at: new Date() },
        }),
    ]);

    await sendTelegramMessage(
        String(chat.id),
        `Vintrack: Telegram connected to <b>${escapeTelegramHTML(chatTitle || "this chat")}</b>. You can now enable Telegram notifications per monitor.`,
    );

    return NextResponse.json({ ok: true });
}

function secretMatches(provided: string | null, expected: string) {
    if (!provided) return false;
    const left = createHash("sha256").update(provided).digest();
    const right = createHash("sha256").update(expected).digest();
    return timingSafeEqual(left, right);
}

function extractConnectCode(text: string) {
    const [command, rawCode] = text.split(/\s+/);
    if (!rawCode) return null;
    if (!command.startsWith("/connect") && !command.startsWith("/start")) {
        return null;
    }
    return rawCode.trim().toUpperCase();
}

function getChatTitle(chat: TelegramChat, message: TelegramMessage) {
    if (chat.title) return chat.title;
    if (chat.username) return `@${chat.username}`;

    const firstName = chat.first_name || message.from?.first_name || "";
    const lastName = chat.last_name || message.from?.last_name || "";
    const fullName = `${firstName} ${lastName}`.trim();
    if (fullName) return fullName;

    if (message.from?.username) return `@${message.from.username}`;
    return null;
}
