"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { MonitorMaintenance } from "@/lib/monitor-maintenance";

type MonitorMaintenanceContextValue = {
    maintenance: MonitorMaintenance;
    setMaintenance: (maintenance: MonitorMaintenance) => void;
};

const MonitorMaintenanceContext =
    createContext<MonitorMaintenanceContextValue | null>(null);

export function MonitorMaintenanceProvider({
    initialMaintenance,
    children,
}: {
    initialMaintenance: MonitorMaintenance;
    children: React.ReactNode;
}) {
    const [maintenance, setMaintenance] = useState(initialMaintenance);
    const value = useMemo(
        () => ({ maintenance, setMaintenance }),
        [maintenance],
    );

    return (
        <MonitorMaintenanceContext.Provider value={value}>
            {children}
        </MonitorMaintenanceContext.Provider>
    );
}

export function useMonitorMaintenance() {
    const context = useContext(MonitorMaintenanceContext);
    if (!context) {
        throw new Error(
            "useMonitorMaintenance must be used inside MonitorMaintenanceProvider",
        );
    }
    return context;
}
