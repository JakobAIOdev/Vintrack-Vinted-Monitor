import { DashboardShell } from "@/components/layout/dashboard-shell";
import { AccountProvider } from "@/components/account-provider";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getMemberAnnouncement } from "@/lib/member-announcement.server";
import { getMonitorMaintenance } from "@/lib/monitor-maintenance.server";

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
    ] =
        await Promise.all([
            db.user.findUnique({
                where: { id: session.user.id },
                select: { role: true },
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

    const user = { ...session.user, role };

    return (
        <AccountProvider>
            <DashboardShell
                user={user}
                announcement={announcement}
                maintenance={maintenance}
                inactivityPausedCount={inactivityPausedCount}
                inactivityPausedPriceWatchCount={
                    inactivityPausedPriceWatchCount
                }
            >
                {children}
            </DashboardShell>
        </AccountProvider>
    );
}
