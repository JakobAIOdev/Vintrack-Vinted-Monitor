"use client";

import { useEffect } from "react";
import { DASHBOARD_ACTIVITY_THROTTLE_MS } from "@/lib/dashboard-activity";

export function DashboardActivity() {
    useEffect(() => {
        let lastSentAt = 0;
        const send = () => {
            if (document.visibilityState !== "visible") return;
            const now = Date.now();
            if (now - lastSentAt < DASHBOARD_ACTIVITY_THROTTLE_MS) return;
            lastSentAt = now;
            void fetch("/api/activity", {
                method: "POST",
                cache: "no-store",
                keepalive: true,
            });
        };
        send();
        const interval = window.setInterval(
            send,
            DASHBOARD_ACTIVITY_THROTTLE_MS,
        );
        document.addEventListener("visibilitychange", send);
        return () => {
            window.clearInterval(interval);
            document.removeEventListener("visibilitychange", send);
        };
    }, []);
    return null;
}
