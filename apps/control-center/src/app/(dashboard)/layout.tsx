import { DashboardShell } from "@/components/layout/dashboard-shell";
import { AccountProvider } from "@/components/account-provider";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getMemberAnnouncement } from "@/lib/member-announcement.server";

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth();

    if (!session?.user?.id) {
        redirect("/login");
    }

    const [dbUser, announcement] = await Promise.all([
        db.user.findUnique({
            where: { id: session.user.id },
            select: { role: true },
        }),
        getMemberAnnouncement(),
    ]);
    const role = dbUser?.role ?? "free";

    const user = { ...session.user, role };

    return (
        <AccountProvider>
            <DashboardShell user={user} announcement={announcement}>
                {children}
            </DashboardShell>
        </AccountProvider>
    );
}
