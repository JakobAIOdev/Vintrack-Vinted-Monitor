import { DashboardShell } from "@/components/layout/dashboard-shell";
import { AccountProvider } from "@/components/account-provider";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getMemberAnnouncement } from "@/lib/member-announcement.server";
import { getMonitorMaintenance } from "@/lib/monitor-maintenance.server";
import { getFeatureCapabilities } from "@/lib/features.server";
import type { Metadata } from "next";

export const metadata: Metadata = {
    robots: {
        index: false,
        follow: false,
    },
};

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth();

    if (!session?.user?.id) {
        redirect("/login");
    }

    const [
        dbUser,
        announcement,
        maintenance,
        inactivityPausedCount,
        inactivityPausedPriceWatchCount,
    ] = await Promise.all([
        db.user.findUnique({
            where: { id: session.user.id },
            select: {
                role: true,
                checkout_enabled: true,
                account_updates_seen_version: true,
            },
        }),
        getMemberAnnouncement(),
        getMonitorMaintenance(),
        db.monitors.count({
            where: {
                userId: session.user.id,
                status: "inactivity_paused",
            },
        }),
        db.price_watches.count({
            where: {
                user_id: session.user.id,
                status: "paused",
                stopped_reason: "inactive_member",
            },
        }),
    ]);
    const role = dbUser?.role ?? "free";
    const features = await getFeatureCapabilities(
        role,
        dbUser?.checkout_enabled === true,
    );

    const user = {
        ...session.user,
        role,
        accountUpdatesSeenVersion: dbUser?.account_updates_seen_version ?? 0,
    };

    return (
        <AccountProvider checkoutEnabled={features.checkout_links.allowed}>
            <DashboardShell
                user={user}
                announcement={announcement}
                maintenance={maintenance}
                inactivityPausedCount={inactivityPausedCount}
                inactivityPausedPriceWatchCount={
                    inactivityPausedPriceWatchCount
                }
                features={features}
            >
                {children}
            </DashboardShell>
        </AccountProvider>
    );
}
