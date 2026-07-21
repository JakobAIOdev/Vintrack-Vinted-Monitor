import {
    formatQueryDelay,
    MAX_QUERY_DELAY_MS,
    MIN_QUERY_DELAY_MS,
} from "@/lib/monitor-delay";

export const DEFAULT_QUIET_HOURS_START_MINUTE = 0;
export const DEFAULT_QUIET_HOURS_END_MINUTE = 7 * 60;
export const DEFAULT_QUIET_HOURS_MODE = "pause" as const;
export const DEFAULT_QUIET_HOURS_DELAY_MS = 60_000;
export const DEFAULT_QUIET_HOURS_TIMEZONE = "Europe/Berlin";

export type QuietHoursMode = "pause" | "slow";

export type QuietHoursSettings = {
    enabled: boolean;
    startMinute: number;
    endMinute: number;
    mode: QuietHoursMode;
    delayMs: number;
    timezone: string;
};

function parseTime(value: FormDataEntryValue | null, fallback: number) {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;

    const match = /^(\d{2}):(\d{2})$/.exec(raw);
    if (!match) throw new Error("Quiet hours must use the HH:MM format");

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
        throw new Error("Quiet hours contain an invalid time");
    }

    return hour * 60 + minute;
}

function normalizeTimezone(value: FormDataEntryValue | null) {
    const timezone = String(value ?? "").trim() || DEFAULT_QUIET_HOURS_TIMEZONE;
    if (timezone.length > 64) throw new Error("Timezone is too long");

    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
        throw new Error("Invalid quiet-hours timezone");
    }

    return timezone;
}

export function normalizeQuietHours(
    formData: FormData,
    normalDelayMs: number,
): QuietHoursSettings {
    const enabled = formData.get("quiet_hours_enabled") === "true";
    const startMinute = parseTime(
        formData.get("quiet_hours_start"),
        DEFAULT_QUIET_HOURS_START_MINUTE,
    );
    const endMinute = parseTime(
        formData.get("quiet_hours_end"),
        DEFAULT_QUIET_HOURS_END_MINUTE,
    );
    const rawMode = String(
        formData.get("quiet_hours_mode") ?? DEFAULT_QUIET_HOURS_MODE,
    );
    if (rawMode !== "pause" && rawMode !== "slow") {
        throw new Error("Invalid quiet-hours mode");
    }

    const rawDelay = String(
        formData.get("quiet_hours_delay_ms") ?? DEFAULT_QUIET_HOURS_DELAY_MS,
    ).trim();
    const parsedDelayMs = Number(rawDelay);
    const delayIsValid =
        Number.isInteger(parsedDelayMs) &&
        parsedDelayMs >= MIN_QUERY_DELAY_MS &&
        parsedDelayMs <= MAX_QUERY_DELAY_MS;
    if (!delayIsValid && enabled && rawMode === "slow") {
        throw new Error(
            `Quiet-hours delay must be between ${MIN_QUERY_DELAY_MS} and ${MAX_QUERY_DELAY_MS} ms`,
        );
    }
    const delayMs = delayIsValid ? parsedDelayMs : DEFAULT_QUIET_HOURS_DELAY_MS;

    if (enabled && startMinute === endMinute) {
        throw new Error("Quiet hours need different start and end times");
    }
    if (enabled && rawMode === "slow" && delayMs < normalDelayMs) {
        throw new Error(
            "Quiet-hours delay must be at least as long as the normal query delay",
        );
    }

    return {
        enabled,
        startMinute,
        endMinute,
        mode: rawMode,
        delayMs,
        timezone: normalizeTimezone(formData.get("quiet_hours_timezone")),
    };
}

export function minuteOfDayToTime(value: number) {
    const normalized = Math.min(1439, Math.max(0, Math.trunc(value)));
    const hour = Math.floor(normalized / 60);
    const minute = normalized % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatQuietHours(settings: QuietHoursSettings) {
    const window = `${minuteOfDayToTime(settings.startMinute)}–${minuteOfDayToTime(settings.endMinute)}`;
    if (settings.mode === "pause") return `Paused ${window}`;
    return `Slowed to ${formatQueryDelay(settings.delayMs)} ${window}`;
}
