"use client";

import { ActiveFilterField } from "@/components/monitors/active-filter-field";
import { FormSection } from "@/components/monitors/monitor-form-sections";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    DEFAULT_QUIET_HOURS_DELAY_MS,
    DEFAULT_QUIET_HOURS_END_MINUTE,
    DEFAULT_QUIET_HOURS_MODE,
    DEFAULT_QUIET_HOURS_START_MINUTE,
    DEFAULT_QUIET_HOURS_TIMEZONE,
    formatQuietHours,
    minuteOfDayToTime,
    type QuietHoursMode,
    type QuietHoursSettings,
} from "@/lib/monitor-schedule";
import { getRegionTimezone, REGIONS } from "@/lib/regions";
import { Clock3 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

type QuietHoursDelayUnit = "seconds" | "minutes";

const DELAY_UNIT_MS: Record<QuietHoursDelayUnit, number> = {
    seconds: 1000,
    minutes: 60_000,
};

function delayUnitForMs(delayMs: number): QuietHoursDelayUnit {
    return delayMs >= DELAY_UNIT_MS.minutes ? "minutes" : "seconds";
}

function formatDelayAmount(delayMs: number, unit: QuietHoursDelayUnit) {
    const value = delayMs / DELAY_UNIT_MS[unit];
    return String(Number(value.toFixed(3)));
}

function subscribeToBrowserTimezone() {
    return () => {};
}

function getBrowserTimezone() {
    return (
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        DEFAULT_QUIET_HOURS_TIMEZONE
    );
}

function getServerTimezone() {
    return DEFAULT_QUIET_HOURS_TIMEZONE;
}

const QUIET_HOURS_TIMEZONE_OPTIONS = REGIONS.map((region) => ({
    ...region,
    timezone: getRegionTimezone(region.code),
}));

export function QuietHoursSection({
    defaultValue,
}: {
    defaultValue?: Partial<QuietHoursSettings>;
}) {
    const initial = {
        enabled: false,
        startMinute: DEFAULT_QUIET_HOURS_START_MINUTE,
        endMinute: DEFAULT_QUIET_HOURS_END_MINUTE,
        mode: DEFAULT_QUIET_HOURS_MODE,
        delayMs: DEFAULT_QUIET_HOURS_DELAY_MS,
        timezone: DEFAULT_QUIET_HOURS_TIMEZONE,
        ...defaultValue,
    } satisfies QuietHoursSettings;
    const [enabled, setEnabled] = useState(initial.enabled);
    const [mode, setMode] = useState<QuietHoursMode>(initial.mode);
    const [startMinute, setStartMinute] = useState(initial.startMinute);
    const [endMinute, setEndMinute] = useState(initial.endMinute);
    const [delayUnit, setDelayUnit] = useState<QuietHoursDelayUnit>(() =>
        delayUnitForMs(initial.delayMs),
    );
    const [delayAmount, setDelayAmount] = useState(() =>
        formatDelayAmount(initial.delayMs, delayUnitForMs(initial.delayMs)),
    );
    const parsedDelayAmount = Number(delayAmount);
    const delayMs = Number.isFinite(parsedDelayAmount)
        ? Math.round(parsedDelayAmount * DELAY_UNIT_MS[delayUnit])
        : 0;
    const hasSavedTimezone = Boolean(defaultValue?.timezone);
    const browserTimezone = useSyncExternalStore(
        subscribeToBrowserTimezone,
        getBrowserTimezone,
        getServerTimezone,
    );
    const [timezoneOverride, setTimezoneOverride] = useState<string | null>(
        hasSavedTimezone ? initial.timezone : null,
    );
    const timezone = timezoneOverride ?? browserTimezone;
    const timezoneIsRegionOption = QUIET_HOURS_TIMEZONE_OPTIONS.some(
        (region) => region.timezone === timezone,
    );
    const quietHoursSummary = enabled
        ? formatQuietHours({
              enabled,
              startMinute,
              endMinute,
              mode,
              delayMs,
              timezone,
          })
        : "";

    const handleDelayUnitChange = (nextUnit: QuietHoursDelayUnit) => {
        setDelayAmount(formatDelayAmount(delayMs, nextUnit));
        setDelayUnit(nextUnit);
    };

    return (
        <FormSection
            title="Quiet Hours"
            description="Reduce proxy usage and alerts during a daily low-activity window."
            defaultOpen={initial.enabled}
            icon={Clock3}
            summary={enabled ? quietHoursSummary : "Off"}
        >
            <ActiveFilterField
                active={enabled}
                summary={quietHoursSummary}
                testId="quiet-hours-filter-field"
            >
                <div className="space-y-5">
                    <input
                        type="hidden"
                        name="quiet_hours_enabled"
                        value={String(enabled)}
                    />
                    <div className="border-border/70 bg-muted/20 flex items-start justify-between gap-4 rounded-lg border p-4">
                        <div>
                            <Label
                                htmlFor="quiet_hours_enabled"
                                className="text-[13px]"
                            >
                                Enable daily quiet hours
                            </Label>
                            <p className="text-muted-foreground mt-1 text-[12px] leading-5">
                                The monitor resumes automatically when the time
                                window ends.
                            </p>
                        </div>
                        <Switch
                            id="quiet_hours_enabled"
                            type="button"
                            checked={enabled}
                            onCheckedChange={setEnabled}
                            aria-label="Enable daily quiet hours"
                        />
                    </div>

                    <div className="space-y-5">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label
                                    htmlFor="quiet_hours_start"
                                    className="text-[13px]"
                                >
                                    Start
                                </Label>
                                <Input
                                    type="time"
                                    name="quiet_hours_start"
                                    id="quiet_hours_start"
                                    value={minuteOfDayToTime(startMinute)}
                                    onChange={(event) => {
                                        const [hour, minute] =
                                            event.target.value
                                                .split(":")
                                                .map(Number);
                                        setStartMinute(hour * 60 + minute);
                                    }}
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label
                                    htmlFor="quiet_hours_end"
                                    className="text-[13px]"
                                >
                                    End
                                </Label>
                                <Input
                                    type="time"
                                    name="quiet_hours_end"
                                    id="quiet_hours_end"
                                    value={minuteOfDayToTime(endMinute)}
                                    onChange={(event) => {
                                        const [hour, minute] =
                                            event.target.value
                                                .split(":")
                                                .map(Number);
                                        setEndMinute(hour * 60 + minute);
                                    }}
                                    required
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label
                                htmlFor="quiet_hours_mode"
                                className="text-[13px]"
                            >
                                During quiet hours
                            </Label>
                            <select
                                name="quiet_hours_mode"
                                id="quiet_hours_mode"
                                value={mode}
                                onChange={(event) =>
                                    setMode(
                                        event.target.value as QuietHoursMode,
                                    )
                                }
                                className="border-input bg-background text-foreground h-10 w-full rounded-md border px-3 text-[13px] focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 focus:outline-none"
                            >
                                <option value="pause">
                                    Pause all checks (maximum savings)
                                </option>
                                <option value="slow">
                                    Use a slower query delay
                                </option>
                            </select>
                        </div>

                        {mode === "slow" && (
                            <div className="space-y-2">
                                <Label
                                    htmlFor="quiet_hours_delay_value"
                                    className="text-[13px]"
                                >
                                    Quiet-hours delay
                                </Label>
                                <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
                                    <Input
                                        type="number"
                                        id="quiet_hours_delay_value"
                                        min={
                                            delayUnit === "minutes" ? 0.01 : 0.5
                                        }
                                        max={
                                            delayUnit === "minutes" ? 60 : 3600
                                        }
                                        step="any"
                                        value={delayAmount}
                                        onChange={(event) =>
                                            setDelayAmount(event.target.value)
                                        }
                                        className="h-10"
                                        required
                                    />
                                    <select
                                        aria-label="Quiet-hours delay unit"
                                        value={delayUnit}
                                        onChange={(event) =>
                                            handleDelayUnitChange(
                                                event.target
                                                    .value as QuietHoursDelayUnit,
                                            )
                                        }
                                        className="border-input bg-background text-foreground h-10 rounded-md border px-3 text-[13px] focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 focus:outline-none"
                                    >
                                        <option value="seconds">Seconds</option>
                                        <option value="minutes">Minutes</option>
                                    </select>
                                </div>
                                <p className="text-muted-foreground text-[12px]">
                                    For example, enter 10 and select Minutes for
                                    one check every ten minutes. Hybrid
                                    discovery is disabled during this window as
                                    well.
                                </p>
                            </div>
                        )}
                        <input
                            type="hidden"
                            name="quiet_hours_delay_ms"
                            value={delayMs}
                        />

                        <div className="space-y-2">
                            <Label
                                htmlFor="quiet_hours_timezone"
                                className="text-[13px]"
                            >
                                Timezone
                            </Label>
                            <select
                                name="quiet_hours_timezone"
                                id="quiet_hours_timezone"
                                value={timezone}
                                onChange={(event) =>
                                    setTimezoneOverride(event.target.value)
                                }
                                className="border-input bg-background text-foreground h-10 w-full rounded-md border px-3 text-[13px] focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 focus:outline-none"
                            >
                                {!timezoneIsRegionOption && (
                                    <optgroup label="Saved or device timezone">
                                        <option value={timezone}>
                                            {timezone}
                                        </option>
                                    </optgroup>
                                )}
                                <optgroup label="Vinted member regions">
                                    {QUIET_HOURS_TIMEZONE_OPTIONS.map(
                                        (region) => (
                                            <option
                                                key={region.code}
                                                value={region.timezone}
                                            >
                                                {region.flag} {region.label} —{" "}
                                                {region.timezone}
                                            </option>
                                        ),
                                    )}
                                </optgroup>
                            </select>
                            <p className="text-muted-foreground text-[12px]">
                                New monitors use your browser timezone. All
                                supported Vinted member regions, including UK
                                and Ireland, are available and daylight-saving
                                changes are automatic.
                            </p>
                        </div>
                    </div>
                </div>
            </ActiveFilterField>
        </FormSection>
    );
}
