import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

const BROWSER_LINK_TOKEN_PATTERN = /^[a-f0-9]{32}$/i;

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
} as const;

export function extensionJson(body: unknown, status = 200) {
    return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export function extensionOptions() {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export type ExtensionPrincipal = {
    userId: string;
};

export type ExtensionAuthentication =
    | { ok: true; principal: ExtensionPrincipal }
    | { ok: false; response: NextResponse };

function readBearerToken(request: Request) {
    const authorization = request.headers.get("authorization")?.trim() ?? "";
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    return match?.[1] ?? "";
}

export async function authenticateExtensionRequest(
    request: Request,
): Promise<ExtensionAuthentication> {
    const token = readBearerToken(request);
    if (!BROWSER_LINK_TOKEN_PATTERN.test(token)) {
        return {
            ok: false,
            response: extensionJson({ error: "Unauthorized" }, 401),
        };
    }

    const tokenHash = createHash("sha256")
        .update(token.toLowerCase(), "utf8")
        .digest("hex");
    const links = await db.$queryRaw<
        Array<{ userId: string; token_hash: string }>
    >`
        SELECT "user_id" AS "userId", "token_hash"
        FROM "vinted_browser_links"
        WHERE "token_hash" = ${tokenHash}
        LIMIT 1
    `;
    const link = links[0];
    if (
        !link ||
        !timingSafeEqual(
            Buffer.from(link.token_hash, "hex"),
            Buffer.from(tokenHash, "hex"),
        )
    ) {
        return {
            ok: false,
            response: extensionJson({ error: "Unauthorized" }, 401),
        };
    }

    await db.$executeRaw`
        UPDATE "vinted_browser_links"
        SET "last_used_at" = NOW(), "updated_at" = NOW()
        WHERE "user_id" = ${link.userId} AND "token_hash" = ${tokenHash}
    `;

    return { ok: true, principal: { userId: link.userId } };
}
