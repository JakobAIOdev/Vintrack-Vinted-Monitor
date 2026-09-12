import {
    authenticateExtensionRequest,
    extensionJson,
    extensionOptions,
} from "@/lib/extension-auth.server";
import { inspectExtensionContext } from "@/lib/extension-context.server";
import { getFeatureAccessForUser } from "@/lib/features.server";

export const dynamic = "force-dynamic";

export function OPTIONS() {
    return extensionOptions();
}

export async function POST(request: Request) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;
    const access = await getFeatureAccessForUser(
        "vinted_account",
        authentication.principal.userId,
    );
    if (!access.allowed) {
        return extensionJson(
            {
                code: "FEATURE_UNAVAILABLE",
                feature: access.feature,
                reason: access.reason,
            },
            403,
        );
    }

    const data = (await request.json().catch(() => null)) as {
        url?: unknown;
    } | null;
    const url = typeof data?.url === "string" ? data.url.trim() : "";
    if (!url || url.length > 12_000) {
        return extensionJson({ error: "Invalid Vinted URL" }, 400);
    }

    try {
        return extensionJson(
            await inspectExtensionContext(authentication.principal.userId, url),
        );
    } catch {
        return extensionJson({ error: "Page context unavailable" }, 500);
    }
}
