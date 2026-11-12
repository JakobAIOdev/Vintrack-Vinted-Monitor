import {
    authenticateExtensionRequest,
    extensionJson,
    extensionOptions,
} from "@/lib/extension-auth.server";
import { getExtensionInlineIndex } from "@/lib/extension-inline-index.server";
import { getFeatureAccessForUser } from "@/lib/features.server";

export const dynamic = "force-dynamic";

export function OPTIONS() {
    return extensionOptions();
}

export async function GET(request: Request) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;
    const { userId } = authentication.principal;

    try {
        // A disabled feature yields an empty section instead of an error, so
        // the remaining inline badges keep working.
        const [liveFeed, priceWatch] = await Promise.all([
            getFeatureAccessForUser("live_feed", userId),
            getFeatureAccessForUser("price_watch", userId),
        ]);
        return extensionJson(
            await getExtensionInlineIndex(userId, {
                finds: liveFeed.allowed,
                watches: priceWatch.allowed,
            }),
        );
    } catch {
        return extensionJson({ error: "Inline index unavailable" }, 500);
    }
}
