import { auth } from "@/auth";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import {
    getFeatureAccess,
    getFeatureAccessForUser,
} from "@/lib/features.server";
import type { FeatureKey } from "@/lib/features";

export async function FeaturePageGate({
    feature,
    children,
}: {
    feature: FeatureKey;
    children: React.ReactNode;
}) {
    const session = await auth();
    const access = session?.user?.id
        ? await getFeatureAccessForUser(feature, session.user.id)
        : await getFeatureAccess(feature, null);
    if (!access.allowed) return <FeatureUnavailable access={access} />;
    return children;
}
