"use client";

import { AdminScrollArea } from "@/components/admin/admin-scroll-area";

import { useState } from "react";
import { ChevronDown, ChevronUp, Globe } from "lucide-react";
import type { getAdminOverviewState } from "@/actions/admin";
import { Button } from "@/components/ui/button";
import { REGIONS } from "@/lib/regions";

type RegionDistribution = Awaited<
    ReturnType<typeof getAdminOverviewState>
>["regionDistribution"];

const number = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
});
const PREVIEW_COUNT = 6;

export function RegionDistributionPanel({
    data,
    loadFailed,
}: {
    data: RegionDistribution | null;
    loadFailed: boolean;
}) {
    const [sortBy, setSortBy] = useState<"runningMonitors" | "runningMembers">(
        "runningMonitors",
    );
    const [showAll, setShowAll] = useState(false);
    const regions = [...(data?.regions ?? [])].sort(
        (a, b) =>
            b[sortBy] - a[sortBy] ||
            b.runningMonitors - a.runningMonitors ||
            a.region.localeCompare(b.region),
    );
    const visibleRegions = showAll ? regions : regions.slice(0, PREVIEW_COUNT);
    const largestValue = regions[0]?.[sortBy] ?? 0;

    return (
        <section
            aria-labelledby="region-distribution-title"
            aria-busy={!data && !loadFailed}
            className="border-border/60 bg-card overflow-hidden rounded-lg border"
        >
            <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div className="flex items-start gap-3">
                    <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <Globe aria-hidden="true" className="size-4" />
                    </div>
                    <div>
                        <h2
                            id="region-distribution-title"
                            className="text-sm font-semibold"
                        >
                            Region distribution
                        </h2>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                            Where members are running their monitors right now.
                        </p>
                    </div>
                </div>
                <div
                    role="group"
                    aria-label="Rank regions by"
                    className="bg-muted/60 flex w-fit shrink-0 gap-1 rounded-lg p-1"
                >
                    {[
                        ["runningMonitors", "Most monitors"],
                        ["runningMembers", "Most members"],
                    ].map(([value, label]) => (
                        <Button
                            key={value}
                            type="button"
                            size="sm"
                            variant={sortBy === value ? "outline" : "ghost"}
                            aria-pressed={sortBy === value}
                            onClick={() => setSortBy(value as typeof sortBy)}
                            className="h-9 text-xs"
                        >
                            {label}
                        </Button>
                    ))}
                </div>
            </div>

            {loadFailed ? (
                <p
                    role="status"
                    className="text-muted-foreground border-t px-4 py-3 text-sm sm:px-5"
                >
                    {data
                        ? "Refresh failed. Showing the last loaded distribution. Use Refresh now to try again."
                        : "Region distribution could not be loaded. Use Refresh now to try again."}
                </p>
            ) : null}

            {data ? (
                <>
                    <dl className="border-border/60 grid grid-cols-3 gap-3 border-y px-4 py-4 sm:gap-6 sm:px-5">
                        {[
                            ["Running monitors", data.runningMonitors],
                            ["Running members", data.runningMembers],
                            ["Active regions", regions.length],
                        ].map(([label, value]) => (
                            <div key={label}>
                                <dt className="text-muted-foreground min-h-8 text-xs sm:min-h-0">
                                    {label}
                                </dt>
                                <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                                    {number.format(Number(value))}
                                </dd>
                            </div>
                        ))}
                    </dl>

                    {regions.length > 0 ? (
                        <AdminScrollArea aria-label="Region distribution table">
                            <table className="w-full table-fixed text-sm">
                                <caption className="sr-only">
                                    Running monitors and unique members by
                                    monitor region, ranked by{" "}
                                    {sortBy === "runningMonitors"
                                        ? "monitors"
                                        : "members"}
                                    . Share is the percentage of all running
                                    monitors.
                                </caption>
                                <thead className="text-muted-foreground bg-card sticky top-0 z-10 text-xs">
                                    <tr>
                                        <th
                                            scope="col"
                                            className="px-4 py-3 text-left font-medium sm:px-5"
                                        >
                                            Region
                                        </th>
                                        <th
                                            scope="col"
                                            className="w-18 px-1 py-3 text-right font-medium sm:w-32 sm:px-2"
                                        >
                                            Monitors
                                        </th>
                                        <th
                                            scope="col"
                                            className="w-18 py-3 pr-4 pl-1 text-right font-medium sm:w-28 sm:pr-2 sm:pl-2"
                                        >
                                            Members
                                        </th>
                                        <th
                                            scope="col"
                                            className="hidden w-28 py-3 pr-5 pl-2 text-right font-medium sm:table-cell"
                                        >
                                            Share
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-border/60 divide-y">
                                    {visibleRegions.map((row) => {
                                        const region = REGIONS.find(
                                            (entry) =>
                                                entry.code === row.region,
                                        );
                                        const share =
                                            data.runningMonitors > 0
                                                ? row.runningMonitors /
                                                  data.runningMonitors
                                                : 0;
                                        return (
                                            <tr key={row.region}>
                                                <th
                                                    scope="row"
                                                    className="px-4 py-3 text-left font-normal sm:px-5"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <span
                                                            aria-hidden="true"
                                                            className="shrink-0 text-base"
                                                        >
                                                            {region?.flag ??
                                                                "🌐"}
                                                        </span>
                                                        <span className="min-w-0 font-medium break-words">
                                                            {region?.label ??
                                                                row.region.toUpperCase()}
                                                        </span>
                                                        <span className="text-muted-foreground ml-1 hidden text-xs uppercase sm:inline">
                                                            {row.region}
                                                        </span>
                                                    </div>
                                                    <div
                                                        aria-hidden="true"
                                                        className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
                                                    >
                                                        <div
                                                            className="h-full rounded-full bg-emerald-600 dark:bg-emerald-400"
                                                            style={{
                                                                width: `${largestValue > 0 ? (row[sortBy] / largestValue) * 100 : 0}%`,
                                                            }}
                                                        />
                                                    </div>
                                                    <span className="text-muted-foreground mt-1 block text-xs sm:hidden">
                                                        {percent.format(share)}{" "}
                                                        of monitors
                                                    </span>
                                                </th>
                                                <td className="px-1 py-3 text-right font-semibold tabular-nums sm:px-2">
                                                    {number.format(
                                                        row.runningMonitors,
                                                    )}
                                                </td>
                                                <td className="py-3 pr-4 pl-1 text-right tabular-nums sm:pr-2 sm:pl-2">
                                                    {number.format(
                                                        row.runningMembers,
                                                    )}
                                                </td>
                                                <td className="text-muted-foreground hidden py-3 pr-5 pl-2 text-right tabular-nums sm:table-cell">
                                                    {percent.format(share)}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </AdminScrollArea>
                    ) : (
                        <div className="px-4 py-10 text-center sm:px-5">
                            <p className="text-sm font-medium">
                                No running monitors yet
                            </p>
                            <p className="text-muted-foreground mt-1 text-sm">
                                Regions will appear when members start their
                                monitors.
                            </p>
                        </div>
                    )}

                    {regions.length > PREVIEW_COUNT ? (
                        <div className="border-border/60 border-t px-4 py-2 sm:px-5">
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-9 w-full text-xs"
                                aria-expanded={showAll}
                                onClick={() => setShowAll(!showAll)}
                            >
                                {showAll
                                    ? "Show top 6"
                                    : `Show all ${regions.length} regions`}
                                {showAll ? (
                                    <ChevronUp aria-hidden="true" />
                                ) : (
                                    <ChevronDown aria-hidden="true" />
                                )}
                            </Button>
                        </div>
                    ) : null}
                    <p className="text-muted-foreground border-border/60 border-t px-4 py-3 text-xs leading-relaxed sm:px-5">
                        Active monitors only. Regions are monitor markets, not
                        member locations. Members count once per region and once
                        in the overall total. Bars compare{" "}
                        {sortBy === "runningMonitors" ? "monitors" : "members"}{" "}
                        with the leading region.
                    </p>
                </>
            ) : !loadFailed ? (
                <div
                    role="status"
                    className="text-muted-foreground border-border/60 border-t px-4 py-10 text-center text-sm sm:px-5"
                >
                    Loading region distribution…
                </div>
            ) : null}
        </section>
    );
}
