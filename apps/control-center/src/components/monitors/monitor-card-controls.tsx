"use client";

import Link, { useLinkStatus } from "next/link";
import { Popover } from "radix-ui";
import { Loader2, PauseCircle, Pencil, PlayCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    getMonitorStatusDescription,
    MonitorLifecycleStatus,
    type MonitorHealth,
} from "@/components/monitors/proxy-health";
import { cn } from "@/lib/utils";

export type MonitorRunAction = "start" | "pause";

function EditLinkContent() {
    const { pending } = useLinkStatus();
    return (
        <span aria-busy={pending} className="flex items-center gap-1.5">
            {pending ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
                <Pencil
                    aria-hidden="true"
                    className="monitor-edit-icon size-3.5"
                />
            )}
            <span className="hidden sm:inline">Edit</span>
        </span>
    );
}

export function MonitorEditLink({ monitorId }: { monitorId: number }) {
    return (
        <Link
            href={`/monitors/${monitorId}/edit?from=dashboard`}
            className="monitor-edit-action ui-action border-border/70 bg-muted/25 text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-8 shrink-0 items-center justify-center rounded-lg border px-2 text-xs font-medium"
            aria-label="Edit monitor"
            title="Edit monitor"
        >
            <EditLinkContent />
        </Link>
    );
}

export function MonitorCardStatus({
    name,
    status,
    health,
    pendingAction,
}: {
    name: string;
    status: string;
    health?: MonitorHealth;
    pendingAction?: MonitorRunAction;
}) {
    const pendingLabel = pendingAction === "start" ? "Starting…" : "Pausing…";
    const description = pendingAction
        ? "Saving the change. The monitor status will update when the request completes."
        : getMonitorStatusDescription(status, health);

    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    aria-label={`Status for ${name}`}
                    aria-busy={Boolean(pendingAction)}
                    aria-hidden={Boolean(pendingAction)}
                    tabIndex={pendingAction ? -1 : undefined}
                    title="View monitor status"
                    className={cn(
                        "monitor-status-trigger hover:bg-muted/60 inline-flex min-h-6 max-w-full min-w-0 items-center rounded-md px-1 py-1 transition-colors duration-150",
                        pendingAction && "invisible",
                    )}
                >
                    {pendingAction ? (
                        <span
                            role="status"
                            className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium"
                        >
                            <Loader2
                                aria-hidden="true"
                                className="size-3 shrink-0 animate-spin"
                            />
                            <span className="truncate">{pendingLabel}</span>
                        </span>
                    ) : (
                        <MonitorLifecycleStatus
                            status={status}
                            health={health}
                            compact
                            indicator="dot"
                        />
                    )}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="start"
                    sideOffset={8}
                    collisionPadding={16}
                    aria-label={`Status for ${name}`}
                    className="dashboard-popover border-border bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border p-4 shadow-lg duration-150 outline-none"
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-muted-foreground text-xs">
                                Monitor status
                            </p>
                            <p className="mt-0.5 truncate text-sm font-semibold">
                                {name}
                            </p>
                        </div>
                        <Popover.Close
                            aria-label="Close monitor status"
                            className="ui-action text-muted-foreground hover:bg-accent hover:text-foreground -mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-lg"
                        >
                            <X aria-hidden="true" className="size-3.5" />
                        </Popover.Close>
                    </div>
                    <p className="text-muted-foreground mt-3 text-xs leading-5">
                        {description}
                    </p>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

export function MonitorRunButton({
    active,
    pendingAction,
    maintenance,
    onClick,
}: {
    active: boolean;
    pendingAction?: MonitorRunAction;
    maintenance: boolean;
    onClick: () => void;
}) {
    return (
        <Button
            variant="ghost"
            size="sm"
            onClick={onClick}
            disabled={Boolean(pendingAction) || (maintenance && !active)}
            aria-busy={Boolean(pendingAction)}
            title={
                maintenance && !active ? "Paused for maintenance" : undefined
            }
            className={cn(
                "monitor-run-action h-auto min-h-8 max-w-full min-w-24 gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium whitespace-normal",
                pendingAction
                    ? "border-border/70 bg-muted/50 text-muted-foreground"
                    : active
                      ? "border-border/70 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                      : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300",
            )}
        >
            {pendingAction ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : active ? (
                <PauseCircle aria-hidden="true" className="size-3.5" />
            ) : (
                <PlayCircle
                    aria-hidden="true"
                    className="monitor-run-icon size-3.5"
                />
            )}
            {pendingAction
                ? pendingAction === "start"
                    ? "Starting…"
                    : "Pausing…"
                : active
                  ? "Pause"
                  : maintenance
                    ? "Paused for maintenance"
                    : "Resume"}
        </Button>
    );
}
