import {
    authenticateExtensionRequest,
    extensionJson,
    extensionOptions,
} from "@/lib/extension-auth.server";
import {
    deleteExtensionPriceWatch,
    setExtensionPriceWatchStatus,
} from "@/lib/extension-price-watch.server";
import { logAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";

export function OPTIONS() {
    return extensionOptions();
}

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;
    const { id } = await context.params;
    const data = (await request.json().catch(() => null)) as {
        status?: unknown;
    } | null;
    if (data?.status !== "active" && data?.status !== "paused") {
        return extensionJson({ error: "Unsupported Price Watch status" }, 400);
    }

    const result = await setExtensionPriceWatchStatus(
        authentication.principal.userId,
        id,
        data.status,
    );
    await logAuditEvent({
        userId: authentication.principal.userId,
        action: "price_watch.extension_status",
        targetType: "price_watch",
        targetId: id,
        status: result.ok ? "success" : "failed",
        metadata: {
            source: "extension",
            requestedStatus: data.status,
            error: result.ok ? null : result.message,
        },
    });
    return result.ok
        ? extensionJson({ ok: true, status: data.status })
        : extensionJson({ error: result.message }, result.status);
}

export async function DELETE(request: Request, context: RouteContext) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;
    const { id } = await context.params;
    const result = await deleteExtensionPriceWatch(
        authentication.principal.userId,
        id,
    );
    await logAuditEvent({
        userId: authentication.principal.userId,
        action: "price_watch.extension_delete",
        targetType: "price_watch",
        targetId: id,
        status: result.ok ? "success" : "failed",
        metadata: {
            source: "extension",
            error: result.ok ? null : result.message,
        },
    });
    return result.ok
        ? extensionJson({ ok: true })
        : extensionJson({ error: result.message }, result.status);
}
