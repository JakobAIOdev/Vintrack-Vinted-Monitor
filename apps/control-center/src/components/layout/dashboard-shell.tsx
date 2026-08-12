"use client";

import { useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { MonitorStreamProvider } from "@/components/monitors/monitor-stream-context";
import { MemberAnnouncementHost } from "@/components/announcements/member-announcement-banner";
import type { MemberAnnouncement } from "@/lib/member-announcement";
import type { MonitorMaintenance } from "@/lib/monitor-maintenance";
import { DashboardActivity } from "@/components/layout/dashboard-activity";
import { Info } from "lucide-react";

interface DashboardShellProps {
    children: React.ReactNode;
    announcement: MemberAnnouncement;
    maintenance: MonitorMaintenance;
    inactivityPausedCount: number;
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
    inactivityPausedCount,
}: DashboardShellProps) {
    const [sidebarOpen, setSidebarOpen] = useState(false);

    return (
        <MonitorStreamProvider>
            <DashboardActivity />
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
                            {inactivityPausedCount > 0 ? (
                                <div
                                    className="mb-4 flex gap-3 rounded-xl border border-sky-500/25 bg-sky-500/8 px-4 py-3 text-sm"
                                    data-testid="inactivity-paused-notice"
                                >
                                    <Info className="mt-0.5 size-4 shrink-0 text-sky-500" />
                                    <div>
                                        <p className="font-semibold">
                                            Monitors paused after inactivity
                                        </p>
                                        <p className="text-muted-foreground mt-0.5 leading-5">
                                            {inactivityPausedCount} monitor
                                            {inactivityPausedCount === 1
                                                ? " was"
                                                : "s were"}{" "}
                                            paused because the dashboard had not
                                            been used for a while. Review and
                                            restart them manually when you are
                                            ready.
                                        </p>
                                    </div>
                                </div>
                            ) : null}
                            {children}
                        </div>
                    </main>
                </div>
            </div>
        </MonitorStreamProvider>
    );
}
