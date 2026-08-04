export const NOTIFICATION_MESSAGE_STYLES = ["rich", "compact"] as const;

export type NotificationMessageStyle =
    (typeof NOTIFICATION_MESSAGE_STYLES)[number];

export function isNotificationMessageStyle(
    value: unknown,
): value is NotificationMessageStyle {
    return NOTIFICATION_MESSAGE_STYLES.includes(
        value as NotificationMessageStyle,
    );
}

export function normalizeNotificationMessageStyle(
    value: unknown,
): NotificationMessageStyle {
    return isNotificationMessageStyle(value) ? value : "rich";
}
