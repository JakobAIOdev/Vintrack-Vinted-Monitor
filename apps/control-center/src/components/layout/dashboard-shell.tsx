"use client";

import { useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { MonitorStreamProvider } from "@/components/monitors/monitor-stream-context";
import { MemberAnnouncementHost } from "@/components/announcements/member-announcement-banner";
import type { MemberAnnouncement } from "@/lib/member-announcement";
import type { MonitorMaintenance } from "@/lib/monitor-maintenance";

interface DashboardShellProps {
    children: React.ReactNode;
    announcement: MemberAnnouncement;
    maintenance: MonitorMaintenance;
    user?: {
        name?: string | null;
        image?: string | null;
        email?: string | null;
        role?: string;
    };
}

export function DashboardShell({
    children,
    user,
    announcement,
    maintenance,
}: DashboardShellProps) {
    const [sidebarOpen, setSidebarOpen] = useState(false);

    return (
        <MonitorStreamProvider>
            <div className="flex min-h-screen bg-transparent">
                {sidebarOpen && (
                    <div
                        className="fixed inset-0 z-40 bg-slate-950/45 backdrop-blur-sm lg:hidden"
                        onClick={() => setSidebarOpen(false)}
                    />
                )}

                <Sidebar
                    user={user}
                    isOpen={sidebarOpen}
                    onClose={() => setSidebarOpen(false)}
                />

                <div className="flex min-w-0 flex-1 flex-col lg:ml-60">
                    <Header onMenuClick={() => setSidebarOpen(true)} />
                    <main className="flex-1 overflow-y-auto p-4 md:p-6">
                        <div className="mx-auto max-w-[88rem]">
                            <MemberAnnouncementHost
                                initialAnnouncement={announcement}
                                initialMaintenance={maintenance}
                                role={user?.role}
                            />
                            {children}
                        </div>
                    </main>
                </div>
            </div>
        </MonitorStreamProvider>
    );
}
