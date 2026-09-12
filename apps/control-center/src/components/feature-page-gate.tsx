import { auth } from "@/auth";
import { db } from "@/lib/db";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { getFeatureAccess } from "@/lib/features.server";
import type { FeatureKey } from "@/lib/features";

export async function FeaturePageGate({
    feature,
    children,
}: {
    feature: FeatureKey;
    children: React.ReactNode;
}) {
    const session = await auth();
    const user = session?.user?.id
        ? await db.user.findUnique({
              where: { id: session.user.id },
              select: { role: true },
          })
        : null;
    const access = await getFeatureAccess(feature, user?.role);
    if (!access.allowed) return <FeatureUnavailable access={access} />;
    return children;
}
