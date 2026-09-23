-- Startup notifications are no longer user-facing. Cancel deliveries that
-- were queued before this release so a delayed dispatcher cannot emit them.
WITH cancelled AS (
    UPDATE alert_deliveries delivery
    SET status = 'cancelled',
        last_reason_code = 'status_notification_retired',
        last_error_detail = 'monitor_started notifications were retired',
        completed_at = NOW(),
        lease_until = NULL,
        claim_token = NULL,
        updated_at = NOW()
    FROM alert_notifications notification
    WHERE notification.id = delivery.notification_id
      AND notification.kind = 'monitor_started'
      AND delivery.status IN ('pending', 'processing', 'retrying')
    RETURNING delivery.id, delivery.notification_id, delivery.channel,
        delivery.attempt_count
)
INSERT INTO alert_events (
    "userId", monitor_id, item_id, notification_id, delivery_id,
    channel, status, notification_kind, reason_code, attempt_number,
    failure_reason
)
SELECT notification.user_id, notification.monitor_id, notification.item_id,
    notification.id, cancelled.id, cancelled.channel, 'cancelled',
    notification.kind, 'status_notification_retired',
    NULLIF(cancelled.attempt_count, 0),
    'monitor_started notifications were retired'
FROM cancelled
JOIN alert_notifications notification
  ON notification.id = cancelled.notification_id;
