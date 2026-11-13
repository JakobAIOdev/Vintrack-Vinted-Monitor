import { auth } from "@/auth";
import { queueCheckoutNotification } from "@/lib/checkout-notifications.server";
import { NextRequest, NextResponse, after } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";
export const maxDuration = 30;
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: NextRequest, context: Context) {
    const { path } = await context.params;
    const operation = path.join("/");
    const publicOperation = ["pair", "next", "checkpoint"].includes(operation);
    const memberOperation =
        ["pair-code", "status", "revoke"].includes(operation) ||
        /^jobs\/[a-f0-9]{64}$/.test(operation);
    if (!publicOperation && !memberOperation)
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    const readOnly = operation === "status" || operation.startsWith("jobs/");
    if (request.method !== (readOnly ? "GET" : "POST"))
        return NextResponse.json(
            { error: "Method not allowed" },
            { status: 405 },
        );
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (publicOperation) {
        // Device endpoints are not browser/session endpoints. Never forward
        // caller-supplied member IDs or cookies to the internal service.
        if (request.headers.has("origin"))
            return NextResponse.json(
                { error: "Use the paired checkout agent" },
                { status: 403 },
            );
        if (operation !== "pair") {
            const authorization = request.headers.get("authorization") || "";
            if (!/^Bearer [a-f0-9]{64}$/.test(authorization))
                return NextResponse.json(
                    { error: "Agent authorization required" },
                    { status: 401 },
                );
            headers.Authorization = authorization;
        }
    } else {
        const session = await auth();
        if (!session?.user?.id)
            return NextResponse.json(
                { error: "Sign in to Vintrack" },
                { status: 401 },
            );
        headers["X-User-ID"] = session.user.id;
        if (
            !readOnly &&
            (request.headers.get("sec-fetch-site") === "cross-site" ||
                (request.headers.get("origin") &&
                    request.headers.get("origin") !==
                        new URL(process.env.AUTH_URL || request.nextUrl.origin)
                            .origin))
        )
            return NextResponse.json(
                { error: "Invalid request origin" },
                { status: 403 },
            );
    }
    let body: Uint8Array | undefined;
    if (!readOnly) {
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > 64 * 1024) {
                    await reader.cancel();
                    return NextResponse.json(
                        { error: "Request too large" },
                        { status: 413 },
                    );
                }
                chunks.push(part.value);
            }
        }
        body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
    }
    // A long poll that its agent abandoned must end upstream as well. Otherwise
    // it keeps waiting and can take the wake-up of the agent's next poll.
    const signal =
        operation === "next"
            ? AbortSignal.any([request.signal, AbortSignal.timeout(25_000)])
            : AbortSignal.timeout(25_000);
    try {
        const response = await fetch(
            `${API_URL}/api/checkout-agent/${operation}`,
            {
                method: request.method,
                headers,
                ...(body ? { body: Buffer.from(body) } : {}),
                cache: "no-store",
                signal,
                redirect: "error",
            },
        );
        const responseBody =
            response.status === 204 ? null : await response.text();
        if (operation.startsWith("jobs/") && response.ok && responseBody) {
            const data = JSON.parse(responseBody);
            const notice = data.notification;
            const userId = headers["X-User-ID"];
            if (
                userId &&
                data.state === "complete" &&
                data.stopped_before_payment === false &&
                notice &&
                Number.isSafeInteger(notice.itemId) &&
                notice.itemId > 0 &&
                Number.isSafeInteger(notice.monitorId) &&
                notice.monitorId > 0
            )
                after(() =>
                    queueCheckoutNotification({
                        userId,
                        itemId: notice.itemId,
                        monitorId: notice.monitorId,
                        transactionId: notice.transactionId,
                        purchaseId: notice.purchaseId,
                        domain: notice.domain,
                        status: notice.status,
                        method: notice.method,
                        payment: notice.payment,
                    }),
                );
        }
        return new NextResponse(responseBody, {
            status: response.status,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "private, no-store",
                Pragma: "no-cache",
            },
        });
    } catch {
        return NextResponse.json(
            {
                error: "Checkout agent coordinator unavailable. Claimed jobs are not replayed.",
            },
            { status: 503 },
        );
    }
}
export const GET = handle;
export const POST = handle;
