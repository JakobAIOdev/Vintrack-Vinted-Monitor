import {
    authenticateExtensionRequest,
    extensionJson,
    extensionOptions,
} from "@/lib/extension-auth.server";
import { getExtensionRecentFeed } from "@/lib/extension-feed.server";

export const dynamic = "force-dynamic";

export function OPTIONS() {
    return extensionOptions();
}

export async function GET(request: Request) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;

    try {
        const items = await getExtensionRecentFeed(
            authentication.principal.userId,
            6,
        );
        return extensionJson({ items, updatedAt: new Date().toISOString() });
    } catch {
        return extensionJson({ error: "Live feed unavailable" }, 500);
    }
}
