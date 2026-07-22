"use client";

import { useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { MonitorStreamProvider } from "@/components/monitors/monitor-stream-context";

interface DashboardShellProps {
    children: React.ReactNode;
    user?: {
        name?: string | null;
        image?: string | null;
        email?: string | null;
        role?: string;
    };
}

export function DashboardShell({ children, user }: DashboardShellProps) {
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
                        <div className="mx-auto max-w-[88rem]">{children}</div>
                    </main>
                </div>
            </div>
        </MonitorStreamProvider>
    );
}
