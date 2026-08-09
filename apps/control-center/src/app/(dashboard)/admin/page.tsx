import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { AdminClient } from "./client";
import { getFreeProxyAdminState } from "@/actions/admin";
import {
    DEFAULT_FREE_PROXY_ACTIVE_LIMIT,
    GLOBAL_MONITOR_LIMIT_SCOPE,
    getMonitorLimits,
    roleLimitScope,
} from "@/lib/monitor-limits";

export const dynamic = "force-dynamic";

export default async function AdminPage({
    searchParams,
}: {
    searchParams?: Promise<{ tab?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) redirect("/login");

    if (session.user.role !== "admin") redirect("/dashboard");

    const roles = ["free", "premium"];
    const [limits, freeProxyState, serverProxyRows, params] = await Promise.all(
        [
            getMonitorLimits([
                GLOBAL_MONITOR_LIMIT_SCOPE,
                ...roles.map(roleLimitScope),
            ]),
            getFreeProxyAdminState(),
            db.$queryRaw<{ value: string }[]>`
                SELECT value FROM app_settings WHERE key = ${"server_proxies"}
            `.catch((error) => {
                console.error("[admin] failed to load server proxies", error);
                return [];
            }),
            searchParams,
        ],
    );

    return (
        <AdminClient
            users={[]}
            logs={[]}
            initialTab={params?.tab}
            currentUserId={session.user.id}
            serverProxies={serverProxyRows[0]?.value ?? ""}
            freeProxyState={freeProxyState}
            monitorLimits={{
                global:
                    limits.get(GLOBAL_MONITOR_LIMIT_SCOPE)?.active_limit ??
                    null,
                roles: Object.fromEntries(
                    roles.map((role) => [
                        role,
                        limits.get(roleLimitScope(role))?.active_limit ?? null,
                    ]),
                ),
                users: {},
                freeProxyGlobal:
                    limits.get(GLOBAL_MONITOR_LIMIT_SCOPE)
                        ?.free_proxy_active_limit ??
                    DEFAULT_FREE_PROXY_ACTIVE_LIMIT,
                freeProxyRoles: Object.fromEntries(
                    roles.map((role) => [
                        role,
                        limits.get(roleLimitScope(role))
                            ?.free_proxy_active_limit ?? null,
                    ]),
                ),
                freeProxyUsers: {},
            }}
        />
    );
}
